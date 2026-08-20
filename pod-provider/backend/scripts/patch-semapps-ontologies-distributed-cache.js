'use strict';

const fs = require('fs');
const path = require('path');

const EXPECTED_PACKAGE = '@semapps/ontologies';
const EXPECTED_VERSION = '1.1.4';
const PATCH_MARKER = 'ADSP-P2_DISTRIBUTED_ONTOLOGY_CACHE';
const ORIGINAL_CACHE_DECLARATION = 'cache: true';
const PATCHED_CACHE_DECLARATION =
  "cache: process.env.SEMAPPS_MOLECULER_MODE === 'distributed' ? false : true";

const ACTION_CONTRACTS = [
  {
    name: 'ontologies.list',
    relativePath: 'actions/list.js',
    signatures: ['Object.values(this.ontologies)']
  },
  {
    name: 'ontologies.get',
    relativePath: 'actions/get.js',
    signatures: ['this.ontologies[prefix]', 'uri.startsWith(o.namespace)']
  },
  {
    name: 'ontologies.getPrefixes',
    relativePath: 'actions/getPrefixes.js',
    signatures: ['this.actions.list', 'Object.fromEntries']
  },
  {
    name: 'ontologies.getRdfPrefixes',
    relativePath: 'actions/getRdfPrefixes.js',
    signatures: ['this.actions.list', 'PREFIX ${ontology.prefix}']
  },
  {
    name: 'ontologies.prefixToUri',
    relativePath: 'actions/prefixToUri.js',
    signatures: ['this.actions.get({ prefix })', 'No ontology found with prefix']
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

function matchesActionContract(source, contract) {
  return contract.signatures.every(signature => source.includes(signature));
}

function locateActionSource(packageRoot, contract) {
  const file = path.join(packageRoot, contract.relativePath);
  if (!fs.existsSync(file)) {
    throw new Error(
      `[ADSP-P2] Expected ${contract.name} at ${contract.relativePath} in ${EXPECTED_PACKAGE}@${EXPECTED_VERSION}`
    );
  }
  const source = fs.readFileSync(file, 'utf8');
  if (!matchesActionContract(source, contract)) {
    throw new Error(
      `[ADSP-P2] ${contract.name} at ${contract.relativePath} no longer matches the pinned ${EXPECTED_PACKAGE}@${EXPECTED_VERSION} contract`
    );
  }
  return file;
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

function patchOntologyActionSource(source, contract) {
  if (!matchesActionContract(source, contract)) {
    throw new Error(`[ADSP-P2] ${contract.name} no longer matches the pinned SemApps ontology-action contract`);
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

  const results = ACTION_CONTRACTS.map(contract => {
    const file = locateActionSource(packageRoot, contract);
    const originalSource = fs.readFileSync(file, 'utf8');
    const result = patchOntologyActionSource(originalSource, contract);
    if (result.changed) fs.writeFileSync(file, result.source, 'utf8');
    return { contract: contract.name, file, changed: result.changed };
  });

  const changed = results.filter(result => result.changed).length;
  process.stdout.write(
    `[ADSP-P2] Distributed ontology cache isolation verified for ${results.length} pinned action(s); patched ${changed}\n`
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
  locateActionSource,
  patchOntologyActionSource,
  applyPatch
};
