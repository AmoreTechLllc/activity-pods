'use strict';

const fs = require('fs');
const path = require('path');

const EXPECTED_PACKAGE = '@semapps/activitypub';
const EXPECTED_VERSION = '1.1.4';
const PATCH_MARKER = 'APDM-P7_LOCAL_RECIPIENT_CONTEXT_REUSE';

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
    source.includes("auth.account.findByWebId") &&
    source.includes('localRecipients.push(recipientUri)') &&
    source.includes('localPost(localRecipients, activity') &&
    source.includes('activitypub.side-effects.processInbox')
  );
}

function locateOutboxSource(packageRoot) {
  const candidates = walkJavaScriptFiles(packageRoot).filter(file => {
    const source = fs.readFileSync(file, 'utf8');
    return source.includes(PATCH_MARKER) || isOutboxCandidate(source);
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
  if (source.includes(PATCH_MARKER)) return { source, changed: false };
  if (!isOutboxCandidate(source)) {
    throw new Error('[APDM-P7] SemApps outbox artifact no longer matches the expected v1.1.4 contract');
  }

  let patched = source;

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
    'this.localPost(localRecipients, activity, localRecipientContexts);',
    'localPost dispatch'
  );

  patched = replaceExactlyOnce(
    patched,
    'async localPost(recipients, activityToPost) {',
    'async localPost(recipients, activityToPost, localRecipientContexts = new Map()) {',
    'localPost signature'
  );

  const originalLookup = "const account = await this.broker.call('auth.account.findByWebId', { webId: recipientUri });";
  const contextAwareLookup = `const account = localRecipientContexts.has(recipientUri)\n            ? { username: localRecipientContexts.get(recipientUri).dataset }\n            : await this.broker.call('auth.account.findByWebId', { webId: recipientUri });`;
  patched = replaceExactlyOnce(patched, originalLookup, contextAwareLookup, 'localPost account lookup');

  return { source: patched, changed: true };
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
    process.stdout.write(`[APDM-P7] Patched ${path.relative(packageRoot, outboxFile)} to reuse local recipient context\n`);
  } else {
    process.stdout.write(`[APDM-P7] ${path.relative(packageRoot, outboxFile)} already patched\n`);
  }

  return { packageRoot, outboxFile, changed: result.changed };
}

if (require.main === module) applyPatch();

module.exports = {
  EXPECTED_PACKAGE,
  EXPECTED_VERSION,
  PATCH_MARKER,
  findPackageRoot,
  locateOutboxSource,
  patchOutboxSource,
  applyPatch
};
