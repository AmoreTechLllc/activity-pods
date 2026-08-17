'use strict';

const fs = require('fs');
const path = require('path');

const EXPECTED_PACKAGE = '@semapps/activitypub';
const EXPECTED_VERSION = '1.1.4';
const PATCH_MARKER = 'APDM-P7_LOCAL_RECIPIENT_CONTEXT_REUSE';
const PHASE8_COMPLETION_MARKER = 'APDM-P8_LOCAL_DELIVERY_COMPLETION_OBSERVER';
const PHASE8_RESULT_MARKER = 'APDM-P8_LOCAL_DELIVERY_RESULT_OBSERVER';
const PHASE10_SCOPE_MARKER = 'APDM-P10_LOCAL_DELIVERY_SCOPE_RUNNER';
const LOCAL_CONTEXT_SYMBOL_KEY = 'semapps-atproto.apdm.local-recipient-contexts';
const LOCAL_DELIVERY_OBSERVER_SYMBOL_KEY = 'semapps-atproto.apdm-p8.local-delivery-observer';
const LOCAL_DELIVERY_RESULT_OBSERVER_SYMBOL_KEY = 'semapps-atproto.apdm-p8.local-delivery-result-observer';
const LOCAL_DELIVERY_SCOPE_RUNNER_SYMBOL_KEY = 'semapps-atproto.apdm-p10.local-delivery-scope-runner';

const PHASE7_CONTEXT_DECLARATION = `const localRecipients = [];\n        const localRecipientContexts = new Map(); // ${PATCH_MARKER}`;
const PHASE7_CONTEXT_INSERTION = `localRecipients.push(recipientUri);\n              localRecipientContexts.set(recipientUri, {\n                dataset: this.settings.podProvider ? account.username : undefined\n              });`;
const PHASE7_CONTEXT_PROPERTY = `Object.defineProperty(activity, Symbol.for('${LOCAL_CONTEXT_SYMBOL_KEY}'), {\n            value: localRecipientContexts,\n            configurable: true,\n            enumerable: false\n          });`;
const PHASE7_CONTEXT_ATTACHMENT = `${PHASE7_CONTEXT_PROPERTY}\n          this.localPost(localRecipients, activity);`;
const PHASE7_CONTEXT_EXTRACTION = `async localPost(recipients, activityToPost) {\n      const localRecipientContextKey = Symbol.for('${LOCAL_CONTEXT_SYMBOL_KEY}');\n      const localRecipientContexts =\n        activityToPost && typeof activityToPost === 'object'\n          ? activityToPost[localRecipientContextKey]\n          : undefined;\n      if (activityToPost && typeof activityToPost === 'object') {\n        delete activityToPost[localRecipientContextKey];\n      }`;
const PHASE7_CONTEXT_AWARE_LOOKUP = `const account = localRecipientContexts instanceof Map && localRecipientContexts.has(recipientUri) &&\n            typeof localRecipientContexts.get(recipientUri)?.dataset === 'string' &&\n            localRecipientContexts.get(recipientUri).dataset.length > 0\n            ? { username: localRecipientContexts.get(recipientUri).dataset }\n            : await this.broker.call('auth.account.findByWebId', { webId: recipientUri });`;
const PHASE10_SCOPE_DISPATCH = `const phase10LocalDeliveryScopeRunner = globalThis[Symbol.for('${LOCAL_DELIVERY_SCOPE_RUNNER_SYMBOL_KEY}')]; // ${PHASE10_SCOPE_MARKER}\n          if (typeof phase10LocalDeliveryScopeRunner === 'function') {\n            phase10LocalDeliveryScopeRunner(() => this.localPost(localRecipients, activity));\n          } else {\n            this.localPost(localRecipients, activity);\n          }`;

function findPackageRoot() {
  let current = path.dirname(require.resolve(EXPECTED_PACKAGE));

  while (current !== path.dirname(current)) {
    const packageJsonPath = path.join(current, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (packageJson.name === EXPECTED_PACKAGE) return current;
    }
    current = path.dirname(current);
  }

  throw new Error(`[APDM-P7] Could not locate ${EXPECTED_PACKAGE} package root`);
}

function walkJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJavaScriptFiles(entryPath));
    } else if (/\.(?:c?js|mjs)$/u.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

function isOutboxCandidate(source) {
  return (
    source.includes('auth.account.findByWebId') &&
    source.includes('localRecipients.push(recipientUri)') &&
    source.includes('localPost(localRecipients, activity') &&
    source.includes('activitypub.side-effects.processInbox')
  );
}

function locateOutboxSource(packageRoot) {
  const candidates = walkJavaScriptFiles(packageRoot).filter(file => {
    const source = fs.readFileSync(file, 'utf8');
    return (
      source.includes(PATCH_MARKER) ||
      source.includes(PHASE8_COMPLETION_MARKER) ||
      source.includes(PHASE8_RESULT_MARKER) ||
      source.includes(PHASE10_SCOPE_MARKER) ||
      isOutboxCandidate(source)
    );
  });

  if (candidates.length !== 1) {
    throw new Error(
      `[APDM-P7] Expected exactly one ${EXPECTED_PACKAGE} outbox artifact, found ${candidates.length}: ${candidates.join(', ')}`
    );
  }

  return candidates[0];
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
  if (count === 0) throw new Error(`[APDM-P7] Could not find ${label} in pinned SemApps artifact`);
  if (count !== 1) throw new Error(`[APDM-P7] Found multiple ${label} matches in pinned SemApps artifact`);
  return source.replace(searchValue, replacement);
}

function assertSingleton(source, value, label, phase = 'P7') {
  const count = occurrenceCount(source, value);
  if (count !== 1) {
    throw new Error(`[APDM-${phase}] Existing patch has unsupported ${label} count/shape (${count})`);
  }
}

function assertPhase7PatchShape(source) {
  assertSingleton(source, PATCH_MARKER, 'Phase 7 marker');
  assertSingleton(source, PHASE7_CONTEXT_DECLARATION, 'local recipient context declaration');
  assertSingleton(source, PHASE7_CONTEXT_INSERTION, 'validated local recipient context insertion');
  assertSingleton(source, PHASE7_CONTEXT_PROPERTY, 'Activity-bound context property');
  assertSingleton(source, PHASE7_CONTEXT_EXTRACTION, 'localPost context extraction/removal');
  assertSingleton(source, PHASE7_CONTEXT_AWARE_LOOKUP, 'context-aware account lookup');
  if (source.includes('this.localPost(localRecipients, activity, localRecipientContexts)')) {
    throw new Error('[APDM-P7] Existing patch drifted to an unsupported third localPost argument');
  }
}

function assertPhase10ScopeShape(source) {
  assertSingleton(source, PHASE10_SCOPE_MARKER, 'Phase 10 scope marker', 'P10');
  assertSingleton(source, PHASE10_SCOPE_DISPATCH, 'reviewed localPost scope dispatch', 'P10');
}

function patchOutboxSource(source) {
  let patched = source;
  let changed = false;

  if (!patched.includes(PATCH_MARKER)) {
    if (!isOutboxCandidate(patched)) {
      throw new Error('[APDM-P7] SemApps outbox artifact no longer matches the expected v1.1.4 contract');
    }

    patched = replaceExactlyOnce(
      patched,
      'const localRecipients = [];',
      PHASE7_CONTEXT_DECLARATION,
      'local recipient declaration'
    );

    patched = replaceExactlyOnce(
      patched,
      'localRecipients.push(recipientUri);',
      PHASE7_CONTEXT_INSERTION,
      'validated local recipient insertion'
    );

    patched = replaceExactlyOnce(
      patched,
      'this.localPost(localRecipients, activity);',
      PHASE7_CONTEXT_ATTACHMENT,
      'localPost dispatch'
    );

    patched = replaceExactlyOnce(
      patched,
      'async localPost(recipients, activityToPost) {',
      PHASE7_CONTEXT_EXTRACTION,
      'localPost context extraction'
    );

    const originalLookup = "const account = await this.broker.call('auth.account.findByWebId', { webId: recipientUri });";
    patched = replaceExactlyOnce(patched, originalLookup, PHASE7_CONTEXT_AWARE_LOOKUP, 'localPost account lookup');
    changed = true;
  }
  assertPhase7PatchShape(patched);

  if (!patched.includes(PHASE8_COMPLETION_MARKER)) {
    if (!patched.includes(PATCH_MARKER)) {
      throw new Error('[APDM-P8] Phase 8 completion seam requires the reviewed Phase 7 local-delivery patch');
    }

    patched = replaceExactlyOnce(
      patched,
      `async localPost(recipients, activityToPost) {\n      const localRecipientContextKey = Symbol.for('${LOCAL_CONTEXT_SYMBOL_KEY}');`,
      `async localPost(recipients, activityToPost) {\n      const phase8LocalDeliveryObserver = globalThis[Symbol.for('${LOCAL_DELIVERY_OBSERVER_SYMBOL_KEY}')]; // ${PHASE8_COMPLETION_MARKER}\n      let phase8LocalDeliveryError;\n      if (typeof phase8LocalDeliveryObserver === 'function') {\n        try {\n          phase8LocalDeliveryObserver('start', activityToPost);\n        } catch (_instrumentationError) {\n          // APDM measurement hooks must never affect local delivery.\n        }\n      }\n      try {\n      const localRecipientContextKey = Symbol.for('${LOCAL_CONTEXT_SYMBOL_KEY}');`,
      'Phase 8 localPost start observer'
    );

    patched = replaceExactlyOnce(
      patched,
      '      return { success, failures };\n    }',
      `      return { success, failures };\n      } catch (error) {\n        phase8LocalDeliveryError = error;\n        throw error;\n      } finally {\n        if (typeof phase8LocalDeliveryObserver === 'function') {\n          try {\n            phase8LocalDeliveryObserver('finish', activityToPost, phase8LocalDeliveryError);\n          } catch (_instrumentationError) {\n            // APDM measurement hooks must never affect local delivery.\n          }\n        }\n      }\n    }`,
      'Phase 8 localPost completion observer'
    );
    changed = true;
  }

  if (!patched.includes(PHASE8_RESULT_MARKER)) {
    if (!patched.includes(PHASE8_COMPLETION_MARKER)) {
      throw new Error('[APDM-P8] Phase 8 result seam requires the completion observer patch');
    }

    patched = replaceExactlyOnce(
      patched,
      `      const phase8LocalDeliveryObserver = globalThis[Symbol.for('${LOCAL_DELIVERY_OBSERVER_SYMBOL_KEY}')]; // ${PHASE8_COMPLETION_MARKER}\n`,
      `      const phase8LocalDeliveryObserver = globalThis[Symbol.for('${LOCAL_DELIVERY_OBSERVER_SYMBOL_KEY}')]; // ${PHASE8_COMPLETION_MARKER}\n      const phase8LocalDeliveryResultObserver = globalThis[Symbol.for('${LOCAL_DELIVERY_RESULT_OBSERVER_SYMBOL_KEY}')]; // ${PHASE8_RESULT_MARKER}\n`,
      'Phase 8 result observer declaration'
    );

    patched = replaceExactlyOnce(
      patched,
      '      return { success, failures };\n      } catch (error) {',
      `      const phase8LocalDeliveryResult = { success, failures };\n      if (typeof phase8LocalDeliveryResultObserver === 'function') {\n        try {\n          phase8LocalDeliveryResultObserver(activityToPost, phase8LocalDeliveryResult);\n        } catch (_instrumentationError) {\n          // APDM measurement hooks must never affect local delivery.\n        }\n      }\n      return phase8LocalDeliveryResult;\n      } catch (error) {`,
      'Phase 8 localPost result observer'
    );
    changed = true;
  }

  if (!patched.includes(PHASE10_SCOPE_MARKER)) {
    if (!patched.includes(PATCH_MARKER)) {
      throw new Error('[APDM-P10] Local delivery scope seam requires the reviewed Phase 7 local-delivery patch');
    }

    patched = replaceExactlyOnce(
      patched,
      '          this.localPost(localRecipients, activity);',
      `          ${PHASE10_SCOPE_DISPATCH}`,
      'Phase 10 localPost scope dispatch'
    );
    changed = true;
  }
  assertPhase10ScopeShape(patched);

  return { source: patched, changed };
}

function applyPatch() {
  const packageRoot = findPackageRoot();
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (packageJson.name !== EXPECTED_PACKAGE || packageJson.version !== EXPECTED_VERSION) {
    throw new Error(
      `[APDM-P7] Refusing to patch ${packageJson.name}@${packageJson.version}; expected exactly ${EXPECTED_PACKAGE}@${EXPECTED_VERSION}`
    );
  }

  const outboxFile = locateOutboxSource(packageRoot);
  const originalSource = fs.readFileSync(outboxFile, 'utf8');
  const result = patchOutboxSource(originalSource);

  if (result.changed) {
    fs.writeFileSync(outboxFile, result.source, 'utf8');
    process.stdout.write(
      `[APDM] Patched ${path.relative(packageRoot, outboxFile)} for Phase 7 context reuse, Phase 8 observation, and the optional Phase 10 local-delivery scope seam\n`
    );
  } else {
    process.stdout.write(`[APDM] ${path.relative(packageRoot, outboxFile)} already patched\n`);
  }

  return { packageRoot, outboxFile, changed: result.changed };
}

if (require.main === module) applyPatch();

module.exports = {
  EXPECTED_PACKAGE,
  EXPECTED_VERSION,
  PATCH_MARKER,
  PHASE8_COMPLETION_MARKER,
  PHASE8_RESULT_MARKER,
  PHASE10_SCOPE_MARKER,
  LOCAL_CONTEXT_SYMBOL_KEY,
  LOCAL_DELIVERY_OBSERVER_SYMBOL_KEY,
  LOCAL_DELIVERY_RESULT_OBSERVER_SYMBOL_KEY,
  LOCAL_DELIVERY_SCOPE_RUNNER_SYMBOL_KEY,
  PHASE7_CONTEXT_DECLARATION,
  PHASE7_CONTEXT_INSERTION,
  PHASE7_CONTEXT_PROPERTY,
  PHASE7_CONTEXT_ATTACHMENT,
  PHASE7_CONTEXT_EXTRACTION,
  PHASE7_CONTEXT_AWARE_LOOKUP,
  PHASE10_SCOPE_DISPATCH,
  occurrenceCount,
  assertPhase7PatchShape,
  assertPhase10ScopeShape,
  findPackageRoot,
  locateOutboxSource,
  patchOutboxSource,
  applyPatch
};
