'use strict';

const fs = require('fs');
const path = require('path');

const EXPECTED_PACKAGE = '@semapps/jsonld';
const EXPECTED_VERSION = '1.1.4';
const PATCH_MARKER = 'ADSP-P2_DISTRIBUTED_JSONLD_CONTEXT_CACHE';
const ORIGINAL_CACHE_DECLARATION = 'cache: true';
const PATCHED_CACHE_DECLARATION =
  "cache: process.env.SEMAPPS_MOLECULER_MODE === 'distributed' ? false : true";

const ACTION_CONTRACTS = [
  {
    name: 'jsonld.context.get',
    signatures: ["ctx.call('ontologies.list')", 'this.actions.getLocal']
  },
  {
    name: 'jsonld.context.getLocal',
    signatures: ["ctx.call('ontologies.list')", 'preserveContextUri']
  }
];

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
    if (entry.isDirectory()) {
      files.push(...walkJavaScriptFiles(entryPath));
    } else if (/\.(?:c?js|mjs)$/u.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

function matchesActionContract(source, contract) {
  return contract.signatures.every(signature => source.includes(signature));
}

function locateActionSource(packageRoot, contract) {
  const candidates = walkJavaScriptFiles(packageRoot).filter(file => {
    const source = fs.readFileSync(file, 'utf8');
    return matchesActionContract(source, contract);
  });

  if (candidates.length !== 1) {
    throw new Error(
      `[ADSP-P2] Expected exactly one ${contract.name} artifact in ${EXPECTED_PACKAGE}@${EXPECTED_VERSION}, found ${candidates.length}: ${candidates.join(', ')}`
    );
  }

  return candidates[0];
}

function countOccurrences(source, needle) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = source.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function patchContextActionSource(source, contract) {
  if (!matchesActionContract(source, contract)) {
    throw new Error(`[ADSP-P2] ${contract.name} no longer matches the pinned SemApps context-action contract`);
  }

  if (source.includes(PATCH_MARKER)) {
    if (!source.includes(PATCHED_CACHE_DECLARATION)) {
      throw new Error(`[ADSP-P2] ${contract.name} contains the patch marker without the expected cache declaration`);
    }
    return { source, changed: false };
  }

  const cacheCount = countOccurrences(source, ORIGINAL_CACHE_DECLARATION);
  if (cacheCount !== 1) {
    throw new Error(
      `[ADSP-P2] Expected exactly one ${ORIGINAL_CACHE_DECLARATION} declaration in ${contract.name}, found ${cacheCount}`
    );
  }

  return {
    source: source.replace(
      ORIGINAL_CACHE_DECLARATION,
      `${PATCHED_CACHE_DECLARATION}, // ${PATCH_MARKER}`
    ),
    changed: true
  };
}

function applyPatch() {
  const packageRoot = findPackageRoot();
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (packageJson.version !== EXPECTED_VERSION) {
    throw new Error(
      `[ADSP-P2] Refusing to patch ${EXPECTED_PACKAGE}@${packageJson.version}; expected exactly ${EXPECTED_VERSION}`
    );
  }

  const results = [];
  for (const contract of ACTION_CONTRACTS) {
    const file = locateActionSource(packageRoot, contract);
    const originalSource = fs.readFileSync(file, 'utf8');
    const result = patchContextActionSource(originalSource, contract);
    if (result.changed) fs.writeFileSync(file, result.source, 'utf8');
    results.push({ contract: contract.name, file, changed: result.changed });
  }

  const changed = results.filter(result => result.changed).length;
  process.stdout.write(
    `[ADSP-P2] Distributed JSON-LD context cache isolation verified for ${results.length} pinned action(s); patched ${changed}\n`
  );

  return { packageRoot, results };
}

if (require.main === module) applyPatch();

module.exports = {
  EXPECTED_PACKAGE,
  EXPECTED_VERSION,
  PATCH_MARKER,
  ORIGINAL_CACHE_DECLARATION,
  PATCHED_CACHE_DECLARATION,
  ACTION_CONTRACTS,
  matchesActionContract,
  patchContextActionSource,
  applyPatch
};
