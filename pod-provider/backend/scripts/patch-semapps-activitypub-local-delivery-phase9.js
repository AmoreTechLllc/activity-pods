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
const LOCAL_DELIVERY_CONCURRENCY_ENV = 'APDM_LOCAL_DELIVERY_CONCURRENCY';
const DEFAULT_LOCAL_DELIVERY_CONCURRENCY = 1;
const MAX_LOCAL_DELIVERY_CONCURRENCY = 32;

function resolveLocalDeliveryConcurrency(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LOCAL_DELIVERY_CONCURRENCY;
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return DEFAULT_LOCAL_DELIVERY_CONCURRENCY;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_LOCAL_DELIVERY_CONCURRENCY;
  return Math.min(parsed, MAX_LOCAL_DELIVERY_CONCURRENCY);
}

function replaceExactlyOnce(source, searchValue, replacement, label) {
  const firstIndex = source.indexOf(searchValue);
  if (firstIndex === -1) throw new Error(`[APDM-P9] Could not find ${label} in pinned SemApps artifact`);
  if (source.indexOf(searchValue, firstIndex + searchValue.length) !== -1) {
    throw new Error(`[APDM-P9] Found multiple ${label} matches in pinned SemApps artifact`);
  }
  return source.replace(searchValue, replacement);
}

function patchPhase9OutboxSource(source) {
  if (source.includes(PHASE9_CONCURRENCY_MARKER)) return { source, changed: false };

  for (const marker of [PATCH_MARKER, PHASE8_COMPLETION_MARKER, PHASE8_RESULT_MARKER]) {
    if (!source.includes(marker)) {
      throw new Error(`[APDM-P9] Required predecessor marker ${marker} is missing`);
    }
  }

  let patched = source;

  patched = replaceExactlyOnce(
    patched,
    '      const success = [];\n      const failures = [];',
    `      const successResults = new Array(recipients.length); // ${PHASE9_CONCURRENCY_MARKER}\n      const failureResults = new Array(recipients.length);\n      const localDeliveryConcurrencyRaw = process.env.${LOCAL_DELIVERY_CONCURRENCY_ENV};\n      const localDeliveryConcurrencyParsed =\n        typeof localDeliveryConcurrencyRaw === 'string' && /^[1-9]\\d*$/u.test(localDeliveryConcurrencyRaw)\n          ? Number(localDeliveryConcurrencyRaw)\n          : NaN;\n      const localDeliveryConcurrency = Number.isSafeInteger(localDeliveryConcurrencyParsed)\n        ? Math.min(localDeliveryConcurrencyParsed, ${MAX_LOCAL_DELIVERY_CONCURRENCY})\n        : ${DEFAULT_LOCAL_DELIVERY_CONCURRENCY};`,
    'local delivery result arrays'
  );

  patched = replaceExactlyOnce(
    patched,
    '      for (const recipientUri of recipients) {\n        try {\n          const account = localRecipientContexts instanceof Map && localRecipientContexts.has(recipientUri)',
    `      const deliverRecipient = async (recipientUri, recipientIndex) => {\n        try {\n          const account = localRecipientContexts instanceof Map && localRecipientContexts.has(recipientUri)`,
    'local recipient loop start'
  );

  patched = replaceExactlyOnce(
    patched,
    '          success.push(recipientUri);',
    '          successResults[recipientIndex] = recipientUri;',
    'local recipient success aggregation'
  );

  patched = replaceExactlyOnce(
    patched,
    '          failures.push(recipientUri);\n        }\n      }\n\n      this.broker.emit',
    `          failureResults[recipientIndex] = recipientUri;\n        }\n      };\n\n      let nextRecipientIndex = 0;\n      const workerCount = Math.min(localDeliveryConcurrency, recipients.length);\n      const workers = Array.from({ length: workerCount }, async () => {\n        while (true) {\n          const recipientIndex = nextRecipientIndex;\n          nextRecipientIndex += 1;\n          if (recipientIndex >= recipients.length) return;\n          await deliverRecipient(recipients[recipientIndex], recipientIndex);\n        }\n      });\n      await Promise.all(workers);\n\n      const success = successResults.filter(recipientUri => recipientUri !== undefined);\n      const failures = failureResults.filter(recipientUri => recipientUri !== undefined);\n\n      this.broker.emit`,
    'local recipient loop completion'
  );

  return { source: patched, changed: true };
}

function applyPatch() {
  const packageRoot = findPackageRoot();
  const packageJson = JSON.parse(fs.readFileSync(`${packageRoot}/package.json`, 'utf8'));
  if (packageJson.name !== EXPECTED_PACKAGE || packageJson.version !== EXPECTED_VERSION) {
    throw new Error(
      `[APDM-P9] Refusing to patch ${packageJson.name}@${packageJson.version}; expected ${EXPECTED_PACKAGE}@${EXPECTED_VERSION}`
    );
  }

  const outboxFile = locateOutboxSource(packageRoot);
  const originalSource = fs.readFileSync(outboxFile, 'utf8');
  const result = patchPhase9OutboxSource(originalSource);

  if (result.changed) {
    fs.writeFileSync(outboxFile, result.source, 'utf8');
    process.stdout.write(
      `[APDM-P9] Patched ${outboxFile} with bounded local delivery concurrency (default ${DEFAULT_LOCAL_DELIVERY_CONCURRENCY}, max ${MAX_LOCAL_DELIVERY_CONCURRENCY})\n`
    );
  } else {
    process.stdout.write(`[APDM-P9] ${outboxFile} already patched\n`);
  }

  return { packageRoot, outboxFile, changed: result.changed };
}

if (require.main === module) applyPatch();

module.exports = {
  PHASE9_CONCURRENCY_MARKER,
  LOCAL_DELIVERY_CONCURRENCY_ENV,
  DEFAULT_LOCAL_DELIVERY_CONCURRENCY,
  MAX_LOCAL_DELIVERY_CONCURRENCY,
  resolveLocalDeliveryConcurrency,
  patchPhase9OutboxSource,
  applyPatch
};
