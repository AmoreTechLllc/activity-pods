'use strict';

const fs = require('fs');
const path = require('path');

const EXPECTED_PACKAGE = '@semapps/activitypub';
const EXPECTED_VERSION = '1.1.4';
const PATCH_MARKER = 'APDM-P7_LOCAL_RECIPIENT_CONTEXT_REUSE';
const PHASE8_COMPLETION_MARKER = 'APDM-P8_LOCAL_DELIVERY_COMPLETION_OBSERVER';
const LOCAL_CONTEXT_SYMBOL_KEY = 'semapps-atproto.apdm.local-recipient-contexts';
const LOCAL_DELIVERY_OBSERVER_SYMBOL_KEY = 'semapps-atproto.apdm-p8.local-delivery-observer';

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
    return source.includes(PATCH_MARKER) || source.includes(PHASE8_COMPLETION_MARKER) || isOutboxCandidate(source);
  });

  if (candidates.length !== 1) {
    throw new Error(
      `[APDM-P7] Expected exactly one ${EXPECTED_PACKAGE} outbox artifact, found ${candidates.length}: ${candidates.join(', ')}`
    );
  }

  return candidates[0];
}

function replaceExactlyOnce(source, searchValue, replacement, label) {
  const firstIndex = source.indexOf(searchValue);
  if (firstIndex === -1) throw new Error(`[APDM-P7] Could not find ${label} in pinned SemApps artifact`);
  if (source.indexOf(searchValue, firstIndex + searchValue.length) !== -1) {
    throw new Error(`[APDM-P7] Found multiple ${label} matches in pinned SemApps artifact`);
  }
  return source.replace(searchValue, replacement);
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
      `const localRecipients = [];\n        const localRecipientContexts = new Map(); // ${PATCH_MARKER}`,
      'local recipient declaration'
    );

    patched = replaceExactlyOnce(
      patched,
      'localRecipients.push(recipientUri);',
      `localRecipients.push(recipientUri);\n              localRecipientContexts.set(recipientUri, {\n                dataset: this.settings.podProvider ? account.username : undefined\n              });`,
      'validated local recipient insertion'
    );

    patched = replaceExactlyOnce(
      patched,
      'this.localPost(localRecipients, activity);',
      `Object.defineProperty(activity, Symbol.for('${LOCAL_CONTEXT_SYMBOL_KEY}'), {\n            value: localRecipientContexts,\n            configurable: true,\n            enumerable: false\n          });\n          this.localPost(localRecipients, activity);`,
      'localPost dispatch'
    );

    patched = replaceExactlyOnce(
      patched,
      'async localPost(recipients, activityToPost) {',
      `async localPost(recipients, activityToPost) {\n      const localRecipientContextKey = Symbol.for('${LOCAL_CONTEXT_SYMBOL_KEY}');\n      const localRecipientContexts =\n        activityToPost && typeof activityToPost === 'object'\n          ? activityToPost[localRecipientContextKey]\n          : undefined;\n      if (activityToPost && typeof activityToPost === 'object') {\n        delete activityToPost[localRecipientContextKey];\n      }`,
      'localPost context extraction'
    );

    const originalLookup = "const account = await this.broker.call('auth.account.findByWebId', { webId: recipientUri });";
    const contextAwareLookup = `const account = localRecipientContexts instanceof Map && localRecipientContexts.has(recipientUri)\n            ? { username: localRecipientContexts.get(recipientUri).dataset }\n            : await this.broker.call('auth.account.findByWebId', { webId: recipientUri });`;
    patched = replaceExactlyOnce(patched, originalLookup, contextAwareLookup, 'localPost account lookup');
    changed = true;
  }

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

  return { source: patched, changed };
}

function applyPatch() {
  const packageRoot = findPackageRoot();
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (packageJson.version !== EXPECTED_VERSION) {
    throw new Error(
      `[APDM-P7] Refusing to patch ${EXPECTED_PACKAGE}@${packageJson.version}; expected exactly ${EXPECTED_VERSION}`
    );
  }

  const outboxFile = locateOutboxSource(packageRoot);
  const originalSource = fs.readFileSync(outboxFile, 'utf8');
  const result = patchOutboxSource(originalSource);

  if (result.changed) {
    fs.writeFileSync(outboxFile, result.source, 'utf8');
    process.stdout.write(`[APDM] Patched ${path.relative(packageRoot, outboxFile)} for Phase 7 context reuse and Phase 8 completion observation\n`);
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
  LOCAL_CONTEXT_SYMBOL_KEY,
  LOCAL_DELIVERY_OBSERVER_SYMBOL_KEY,
  findPackageRoot,
  locateOutboxSource,
  patchOutboxSource,
  applyPatch
};
