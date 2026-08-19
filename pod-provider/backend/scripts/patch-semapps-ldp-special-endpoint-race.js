'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXPECTED_PACKAGE = '@semapps/ldp';
const EXPECTED_VERSION = '1.1.4';
const PATCH_MARKER = 'ADSP-P2_IDEMPOTENT_SPECIAL_ENDPOINT_STARTUP';

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
  throw new Error(`[ADSP-P2] Could not locate ${EXPECTED_PACKAGE} package root`);
}

function walkJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkJavaScriptFiles(entryPath));
    else if (/\.(?:c?js|mjs)$/u.test(entry.name)) files.push(entryPath);
  }
  return files;
}

function isSpecialEndpointCandidate(source) {
  return (
    source.includes('ldp.resource.exist') &&
    source.includes('ldp.resource.create') &&
    source.includes('this.settings.endpoint.path') &&
    source.includes('this.settings.endpoint.initialData') &&
    source.includes('this.endpointUrl') &&
    source.includes('settingsDataset') &&
    source.includes('started')
  );
}

function isPatchedSpecialEndpointCandidate(source) {
  return (
    source.includes(PATCH_MARKER) &&
    isSpecialEndpointCandidate(source) &&
    source.includes('const adspP2EndpointExistsAfterCreateRace = await this.broker.call(') &&
    source.includes("'ldp.resource.exist'") &&
    source.includes("{ resourceUri: this.endpointUrl, webId: 'system' }") &&
    source.includes('{ meta: { dataset: this.settings.settingsDataset } }') &&
    source.includes('if (!adspP2EndpointExistsAfterCreateRace) throw error;')
  );
}

function locateSpecialEndpointSource(packageRoot) {
  const preferred = path.join(packageRoot, 'mixins', 'special-endpoint.js');
  if (fs.existsSync(preferred)) {
    const preferredSource = fs.readFileSync(preferred, 'utf8');
    if (preferredSource.includes(PATCH_MARKER)) {
      if (isPatchedSpecialEndpointCandidate(preferredSource)) return preferred;
      throw new Error('[ADSP-P2] Existing special-endpoint patch marker no longer matches the reviewed repair contract');
    }
    if (isSpecialEndpointCandidate(preferredSource)) return preferred;
    throw new Error('[ADSP-P2] Pinned @semapps/ldp mixins/special-endpoint.js no longer matches the reviewed v1.1.4 contract');
  }

  const candidates = walkJavaScriptFiles(packageRoot).filter(file => {
    const source = fs.readFileSync(file, 'utf8');
    return isPatchedSpecialEndpointCandidate(source) || (!source.includes(PATCH_MARKER) && isSpecialEndpointCandidate(source));
  });
  if (candidates.length !== 1) {
    throw new Error(
      `[ADSP-P2] Expected exactly one ${EXPECTED_PACKAGE} special-endpoint artifact, found ${candidates.length}: ${candidates.join(', ')}`
    );
  }
  return candidates[0];
}

function findCallBounds(source, actionName, fromIndex = 0) {
  const actionIndex = source.indexOf(actionName, fromIndex);
  if (actionIndex === -1) throw new Error(`[ADSP-P2] Could not locate ${actionName}`);
  const callStart = source.lastIndexOf('this.broker.call(', actionIndex);
  if (callStart === -1) throw new Error(`[ADSP-P2] ${actionName} is no longer invoked through this.broker.call`);

  // The reviewed v1.1.4 contract awaits this broker call. Include the `await`
  // in the replacement bounds; leaving it behind would produce `await try {}`.
  const awaitStart = source.lastIndexOf('await ', callStart);
  if (awaitStart === -1 || source.slice(awaitStart + 'await '.length, callStart).trim() !== '') {
    throw new Error(`[ADSP-P2] ${actionName} call is no longer directly awaited as reviewed`);
  }

  const openParen = source.indexOf('(', callStart);
  let depth = 1;
  let quote = null;
  let escaped = false;
  for (let index = openParen + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        const semicolon = source.indexOf(';', index);
        if (semicolon === -1 || semicolon - index > 12) {
          throw new Error(`[ADSP-P2] Could not locate the end of ${actionName} call`);
        }
        return { start: awaitStart, end: semicolon + 1 };
      }
    }
  }
  throw new Error(`[ADSP-P2] Unterminated ${actionName} call`);
}

function assertParsableJavaScript(source, filename = 'special-endpoint.js') {
  try {
    new vm.Script(source, { filename });
  } catch (error) {
    const wrapped = new Error(`[ADSP-P2] Refusing to write syntactically invalid patched ${filename}: ${error.message}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

function patchSpecialEndpointSource(source) {
  if (source.includes(PATCH_MARKER)) {
    if (!isPatchedSpecialEndpointCandidate(source)) {
      throw new Error('[ADSP-P2] Existing special-endpoint patch marker no longer matches the reviewed repair contract');
    }
    assertParsableJavaScript(source);
    return { source, changed: false };
  }
  if (!isSpecialEndpointCandidate(source)) {
    throw new Error('[ADSP-P2] SemApps special-endpoint artifact no longer matches the expected v1.1.4 contract');
  }

  const createBounds = findCallBounds(source, 'ldp.resource.create');
  const createCall = source.slice(createBounds.start, createBounds.end);
  const replacement = `/* ${PATCH_MARKER} */\n      try {\n        ${createCall}\n      } catch (error) {\n        // Multiple full ActivityPods replicas may start against the same shared LDP dataset.\n        // The upstream special-endpoint mixin uses an exist-then-create sequence, so two\n        // replicas can both observe absence and race to create the same canonical endpoint.\n        // Only suppress that race if a fresh authoritative existence read proves another\n        // replica completed the exact resource creation. All other failures remain fatal.\n        const adspP2EndpointExistsAfterCreateRace = await this.broker.call(\n          'ldp.resource.exist',\n          { resourceUri: this.endpointUrl, webId: 'system' },\n          { meta: { dataset: this.settings.settingsDataset } }\n        );\n        if (!adspP2EndpointExistsAfterCreateRace) throw error;\n        this.logger.info(\n          \`[ADSP-P2] Special endpoint already initialized by another replica: \${this.endpointUrl}\`\n        );\n      }`;

  const patchedSource = `${source.slice(0, createBounds.start)}${replacement}${source.slice(createBounds.end)}`;
  if (!isPatchedSpecialEndpointCandidate(patchedSource)) {
    throw new Error('[ADSP-P2] Generated special-endpoint patch does not satisfy the reviewed repair contract');
  }
  assertParsableJavaScript(patchedSource);
  return { source: patchedSource, changed: true };
}

function applyPatch() {
  const packageRoot = findPackageRoot();
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (packageJson.version !== EXPECTED_VERSION) {
    throw new Error(
      `[ADSP-P2] Refusing to patch ${EXPECTED_PACKAGE}@${packageJson.version}; expected exactly ${EXPECTED_VERSION}`
    );
  }

  const file = locateSpecialEndpointSource(packageRoot);
  const original = fs.readFileSync(file, 'utf8');
  const result = patchSpecialEndpointSource(original);
  // Validate both syntax and the semantic marker contract immediately before
  // the destructive write/reuse of the installed dependency artifact.
  if (!isPatchedSpecialEndpointCandidate(result.source)) {
    throw new Error('[ADSP-P2] Refusing to use a patched special-endpoint artifact whose repair contract drifted');
  }
  assertParsableJavaScript(result.source, file);
  if (result.changed) {
    fs.writeFileSync(file, result.source, 'utf8');
    process.stdout.write(
      `[ADSP-P2] Patched ${path.relative(packageRoot, file)} so concurrent special-endpoint startup is idempotent\n`
    );
  } else {
    process.stdout.write(`[ADSP-P2] ${path.relative(packageRoot, file)} already patched\n`);
  }
  return { packageRoot, file, changed: result.changed };
}

if (require.main === module) applyPatch();

module.exports = {
  EXPECTED_PACKAGE,
  EXPECTED_VERSION,
  PATCH_MARKER,
  assertParsableJavaScript,
  isPatchedSpecialEndpointCandidate,
  isSpecialEndpointCandidate,
  locateSpecialEndpointSource,
  patchSpecialEndpointSource,
  applyPatch
};
