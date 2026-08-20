'use strict';

const fs = require('fs');
const {
  EXPECTED_PACKAGE,
  EXPECTED_VERSION,
  PATCH_MARKER,
  PHASE8_COMPLETION_MARKER,
  PHASE8_RESULT_MARKER,
  findPackageRoot,
  locateOutboxSource
} = require('./patch-semapps-activitypub-local-delivery');

const PHASE9_CONCURRENCY_MARKER = 'APDM-P9_BOUNDED_LOCAL_DELIVERY_CONCURRENCY';
const PHASE9_C4_DEFAULT_MARKER = 'APDM-P9_DEFAULT_LOCAL_DELIVERY_CONCURRENCY_C4';
const LOCAL_DELIVERY_CONCURRENCY_ENV = 'APDM_LOCAL_DELIVERY_CONCURRENCY';
const DEFAULT_LOCAL_DELIVERY_CONCURRENCY = 4;
const INVALID_LOCAL_DELIVERY_CONCURRENCY_FALLBACK = 1;
const MAX_LOCAL_DELIVERY_CONCURRENCY = 32;

function resolveLocalDeliveryConcurrency(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LOCAL_DELIVERY_CONCURRENCY;
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return INVALID_LOCAL_DELIVERY_CONCURRENCY_FALLBACK;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return INVALID_LOCAL_DELIVERY_CONCURRENCY_FALLBACK;
  return Math.min(parsed, MAX_LOCAL_DELIVERY_CONCURRENCY);
}

function occurrenceCount(source, value) {
  let count = 0;
  let cursor = 0;
  while (value && cursor <= source.length) {
    const index = source.indexOf(value, cursor);
    if (index === -1) break;
    count += 1;
    cursor = index + value.length;
  }
  return count;
}

function replaceExactlyOnce(source, searchValue, replacement, label) {
  const count = occurrenceCount(source, searchValue);
  if (count !== 1) throw new Error(`[APDM-P9] Expected exactly one ${label} in pinned SemApps artifact, found ${count}`);
  return source.replace(searchValue, replacement);
}

const LEGACY_PHASE9_CONCURRENCY_BLOCK = `      const successResults = new Array(recipients.length); // ${PHASE9_CONCURRENCY_MARKER}\n      const failureResults = new Array(recipients.length);\n      const localDeliveryConcurrencyRaw = process.env.${LOCAL_DELIVERY_CONCURRENCY_ENV};\n      const localDeliveryConcurrencyParsed =\n        typeof localDeliveryConcurrencyRaw === 'string' && /^[1-9]\\d*$/u.test(localDeliveryConcurrencyRaw)\n          ? Number(localDeliveryConcurrencyRaw)\n          : NaN;\n      const localDeliveryConcurrency = Number.isSafeInteger(localDeliveryConcurrencyParsed)\n        ? Math.min(localDeliveryConcurrencyParsed, ${MAX_LOCAL_DELIVERY_CONCURRENCY})\n        : 1;`;

const PROMOTED_PHASE9_CONCURRENCY_BLOCK = `      const successResults = new Array(recipients.length); // ${PHASE9_CONCURRENCY_MARKER}; ${PHASE9_C4_DEFAULT_MARKER}\n      const failureResults = new Array(recipients.length);\n      const localDeliveryConcurrencyRaw = process.env.${LOCAL_DELIVERY_CONCURRENCY_ENV};\n      const localDeliveryConcurrencyParsed =\n        typeof localDeliveryConcurrencyRaw === 'string' && /^[1-9]\\d*$/u.test(localDeliveryConcurrencyRaw)\n          ? Number(localDeliveryConcurrencyRaw)\n          : NaN;\n      const localDeliveryConcurrency =\n        localDeliveryConcurrencyRaw === undefined || localDeliveryConcurrencyRaw === ''\n          ? ${DEFAULT_LOCAL_DELIVERY_CONCURRENCY}\n          : Number.isSafeInteger(localDeliveryConcurrencyParsed) && localDeliveryConcurrencyParsed >= 1\n            ? Math.min(localDeliveryConcurrencyParsed, ${MAX_LOCAL_DELIVERY_CONCURRENCY})\n            : ${INVALID_LOCAL_DELIVERY_CONCURRENCY_FALLBACK};`;

const PHASE9_WORKER_BLOCK = `      let nextRecipientIndex = 0;\n      const workerCount = Math.min(localDeliveryConcurrency, recipients.length);\n      const workers = Array.from({ length: workerCount }, async () => {\n        while (true) {\n          const recipientIndex = nextRecipientIndex;\n          nextRecipientIndex += 1;\n          if (recipientIndex >= recipients.length) return;\n          await deliverRecipient(recipients[recipientIndex], recipientIndex);\n        }\n      });\n      await Promise.all(workers);\n\n      const success = successResults.filter(recipientUri => recipientUri !== undefined);\n      const failures = failureResults.filter(recipientUri => recipientUri !== undefined);`;

function assertPhase9WorkerShape(source, { promoted = source.includes(PHASE9_C4_DEFAULT_MARKER) } = {}) {
  for (const marker of [PATCH_MARKER, PHASE8_COMPLETION_MARKER, PHASE8_RESULT_MARKER, PHASE9_CONCURRENCY_MARKER]) {
    if (occurrenceCount(source, marker) !== 1) throw new Error(`[APDM-P9] Existing Phase 9 artifact has unsupported predecessor/marker count for ${marker}`);
  }
  if (promoted && occurrenceCount(source, PROMOTED_PHASE9_CONCURRENCY_BLOCK) !== 1) throw new Error('[APDM-P9] Existing Phase 9 marker has drifted promoted concurrency configuration');
  if (occurrenceCount(source, PHASE9_WORKER_BLOCK) !== 1) throw new Error('[APDM-P9] Existing Phase 9 marker has unsupported worker shape');
  if (occurrenceCount(source, 'successResults[recipientIndex] = recipientUri;') !== 1 || occurrenceCount(source, 'failureResults[recipientIndex] = recipientUri;') !== 1) throw new Error('[APDM-P9] Existing Phase 9 marker has unsupported result aggregation shape');
  if (source.includes('success.push(recipientUri);') || source.includes('failures.push(recipientUri);')) throw new Error('[APDM-P9] Existing Phase 9 artifact retained legacy unordered aggregation');
}

function patchPhase9OutboxSource(source) {
  if (source.includes(PHASE9_C4_DEFAULT_MARKER)) {
    assertPhase9WorkerShape(source, { promoted: true });
    return { source, changed: false };
  }
  if (source.includes(PHASE9_CONCURRENCY_MARKER)) {
    assertPhase9WorkerShape(source, { promoted: false });
    const migrated = replaceExactlyOnce(source, LEGACY_PHASE9_CONCURRENCY_BLOCK, PROMOTED_PHASE9_CONCURRENCY_BLOCK, 'reviewed Phase 9 c1 concurrency configuration block');
    assertPhase9WorkerShape(migrated, { promoted: true });
    return { source: migrated, changed: true };
  }
  for (const marker of [PATCH_MARKER, PHASE8_COMPLETION_MARKER, PHASE8_RESULT_MARKER]) {
    if (!source.includes(marker)) throw new Error(`[APDM-P9] Required predecessor marker ${marker} is missing`);
  }
  let patched = source;
  patched = replaceExactlyOnce(patched, '      const success = [];\n      const failures = [];', PROMOTED_PHASE9_CONCURRENCY_BLOCK, 'local delivery result arrays');
  patched = replaceExactlyOnce(patched, '      for (const recipientUri of recipients) {\n        try {\n          const account = localRecipientContexts instanceof Map && localRecipientContexts.has(recipientUri)', `      const deliverRecipient = async (recipientUri, recipientIndex) => {\n        try {\n          const account = localRecipientContexts instanceof Map && localRecipientContexts.has(recipientUri)`, 'local recipient loop start');
  patched = replaceExactlyOnce(patched, '          success.push(recipientUri);', '          successResults[recipientIndex] = recipientUri;', 'local recipient success aggregation');
  patched = replaceExactlyOnce(patched, '          failures.push(recipientUri);\n        }\n      }\n\n      this.broker.emit', `          failureResults[recipientIndex] = recipientUri;\n        }\n      };\n\n${PHASE9_WORKER_BLOCK}\n\n      this.broker.emit`, 'local recipient loop completion');
  assertPhase9WorkerShape(patched, { promoted: true });
  return { source: patched, changed: true };
}

function applyPatch() {
  const packageRoot = findPackageRoot();
  const packageJson = JSON.parse(fs.readFileSync(`${packageRoot}/package.json`, 'utf8'));
  if (packageJson.name !== EXPECTED_PACKAGE || packageJson.version !== EXPECTED_VERSION) throw new Error(`[APDM-P9] Refusing to patch ${packageJson.name}@${packageJson.version}; expected ${EXPECTED_PACKAGE}@${EXPECTED_VERSION}`);
  const outboxFile = locateOutboxSource(packageRoot);
  const originalSource = fs.readFileSync(outboxFile, 'utf8');
  const result = patchPhase9OutboxSource(originalSource);
  if (result.changed) {
    fs.writeFileSync(outboxFile, result.source, 'utf8');
    process.stdout.write(`[APDM-P9] Patched ${outboxFile} with bounded local delivery concurrency (default ${DEFAULT_LOCAL_DELIVERY_CONCURRENCY}, invalid fallback ${INVALID_LOCAL_DELIVERY_CONCURRENCY_FALLBACK}, max ${MAX_LOCAL_DELIVERY_CONCURRENCY})\n`);
  } else process.stdout.write(`[APDM-P9] ${outboxFile} already patched with c4 default\n`);
  return { packageRoot, outboxFile, changed: result.changed };
}

if (require.main === module) applyPatch();

module.exports = {
  PHASE9_CONCURRENCY_MARKER,
  PHASE9_C4_DEFAULT_MARKER,
  LOCAL_DELIVERY_CONCURRENCY_ENV,
  DEFAULT_LOCAL_DELIVERY_CONCURRENCY,
  INVALID_LOCAL_DELIVERY_CONCURRENCY_FALLBACK,
  MAX_LOCAL_DELIVERY_CONCURRENCY,
  LEGACY_PHASE9_CONCURRENCY_BLOCK,
  PROMOTED_PHASE9_CONCURRENCY_BLOCK,
  PHASE9_WORKER_BLOCK,
  occurrenceCount,
  resolveLocalDeliveryConcurrency,
  assertPhase9WorkerShape,
  patchPhase9OutboxSource,
  applyPatch
};
