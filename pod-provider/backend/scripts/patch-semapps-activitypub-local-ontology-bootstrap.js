'use strict';

const fs = require('fs');
const path = require('path');

const EXPECTED_PACKAGE = '@semapps/activitypub';
const EXPECTED_VERSION = '1.1.4';
const ACTION_NAME = 'ontologies.register';
const PATCH_MARKER = 'ADSP-P2_LOCAL_ACTIVITYPUB_ONTOLOGY_BOOTSTRAP';
const LOCAL_READY_TIMEOUT_MS = 30000;
const LOCAL_READY_POLL_MS = 25;

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

function countOccurrences(source, needle) {
  let count = 0;
  let offset = 0;
  for (;;) {
    const index = source.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function isActivityPubRootCandidate(source) {
  return (
    countOccurrences(source, ACTION_NAME) === 2 &&
    source.includes('dependencies') &&
    source.includes('ontologies') &&
    source.includes('async started()')
  );
}

function locateActivityPubRootSource(packageRoot) {
  const candidates = walkJavaScriptFiles(packageRoot).filter(file => {
    const source = fs.readFileSync(file, 'utf8');
    return source.includes(PATCH_MARKER) || isActivityPubRootCandidate(source);
  });
  if (candidates.length !== 1) {
    throw new Error(
      `[ADSP-P2] Expected exactly one ${EXPECTED_PACKAGE} ActivityPub root ontology-bootstrap artifact, found ${candidates.length}: ${candidates.join(', ')}`
    );
  }
  return candidates[0];
}

function findBootstrapCalls(source) {
  const callPattern = /await\s+this\.broker\.call\((['"])ontologies\.register\1,\s*([^;\n]+)\);/gu;
  const matches = [...source.matchAll(callPattern)];
  if (matches.length !== 2) {
    throw new Error(`[ADSP-P2] Expected exactly two broker ${ACTION_NAME} bootstrap calls, found ${matches.length}`);
  }
  return matches;
}

function patchActivityPubOntologyBootstrapSource(source) {
  if (source.includes(PATCH_MARKER)) {
    if (!source.includes("this.broker.getLocalService('ontologies')")) {
      throw new Error('[ADSP-P2] ActivityPub ontology bootstrap contains patch marker without local ontology lookup');
    }
    return { source, changed: false };
  }
  if (!isActivityPubRootCandidate(source)) {
    throw new Error('[ADSP-P2] SemApps ActivityPub root no longer matches the expected v1.1.4 ontology-bootstrap contract');
  }

  const matches = findBootstrapCalls(source);
  const first = matches[0];
  const second = matches[1];
  const firstStart = first.index;
  const secondEnd = second.index + second[0].length;
  const firstArg = first[2].trim();
  const secondArg = second[2].trim();

  const replacement = `if (process.env.SEMAPPS_MOLECULER_MODE === 'distributed') { // ${PATCH_MARKER}\n      const adspP2LocalOntologyDeadline = Date.now() + ${LOCAL_READY_TIMEOUT_MS};\n      let adspP2LocalOntologies;\n      do {\n        adspP2LocalOntologies = this.broker.getLocalService('ontologies');\n        if (adspP2LocalOntologies?.actions && typeof adspP2LocalOntologies.actions.register === 'function') break;\n        if (Date.now() >= adspP2LocalOntologyDeadline) {\n          throw new Error('[ADSP-P2] Local ontologies service did not become ready before ActivityPub ontology bootstrap deadline');\n        }\n        await new Promise(resolve => setTimeout(resolve, ${LOCAL_READY_POLL_MS}));\n      } while (true);\n      await adspP2LocalOntologies.actions.register(${firstArg});\n      await adspP2LocalOntologies.actions.register(${secondArg});\n    } else {\n      ${first[0]}\n      ${second[0]}\n    }`;

  return {
    source: `${source.slice(0, firstStart)}${replacement}${source.slice(secondEnd)}`,
    changed: true
  };
}

function applyPatch() {
  const packageRoot = findPackageRoot();
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (packageJson.version !== EXPECTED_VERSION) {
    throw new Error(`[ADSP-P2] Refusing to patch ${EXPECTED_PACKAGE}@${packageJson.version}; expected exactly ${EXPECTED_VERSION}`);
  }

  const file = locateActivityPubRootSource(packageRoot);
  const originalSource = fs.readFileSync(file, 'utf8');
  const result = patchActivityPubOntologyBootstrapSource(originalSource);
  if (result.changed) fs.writeFileSync(file, result.source, 'utf8');
  process.stdout.write(
    `[ADSP-P2] ActivityPub local ontology bootstrap verified in ${path.relative(packageRoot, file)}; patched ${result.changed ? 1 : 0}\n`
  );
  return { packageRoot, file, changed: result.changed };
}

if (require.main === module) applyPatch();

module.exports = {
  EXPECTED_PACKAGE,
  EXPECTED_VERSION,
  ACTION_NAME,
  PATCH_MARKER,
  LOCAL_READY_TIMEOUT_MS,
  LOCAL_READY_POLL_MS,
  isActivityPubRootCandidate,
  findBootstrapCalls,
  patchActivityPubOntologyBootstrapSource,
  applyPatch
};
