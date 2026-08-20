'use strict';

const fs = require('fs');
const path = require('path');

const EXPECTED_PACKAGE = '@semapps/ldp';
const EXPECTED_VERSION = '1.1.4';
const PATCH_MARKER = 'ADSP-P2_DISTRIBUTED_LDP_SEMANTIC_LOCALITY';
const RELATIVE_PATH = 'services/registry/actions/register.js';
const ORIGINAL_EXPANSION = "options.acceptedTypes && (await ctx.call('jsonld.parser.expandTypes', { types: options.acceptedTypes }))";
const PATCHED_FRAGMENTS = [
  "process.env.SEMAPPS_MOLECULER_MODE === 'distributed'",
  "this.broker.getLocalService('jsonld.parser')",
  'service.actions.expandTypes({ types: options.acceptedTypes }, { parentCtx: ctx })',
  "ctx.call('jsonld.parser.expandTypes', { types: options.acceptedTypes })"
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

function isAlreadyPatched(source) {
  if (source.includes(PATCH_MARKER)) return true;
  return PATCHED_FRAGMENTS.every(fragment => source.includes(fragment));
}

function addPatchMarker(source) {
  if (source.includes(PATCH_MARKER)) return source;
  if (source.includes('const Schema = {')) {
    return source.replace('const Schema = {', `const Schema = {\n  // ${PATCH_MARKER}`);
  }
  return `// ${PATCH_MARKER}\n${source}`;
}

function patchRegisterSource(source) {
  if (isAlreadyPatched(source)) return { source, changed: false };
  if (!source.includes(ORIGINAL_EXPANSION) || !source.includes('this.registeredContainers[options.name] = options')) {
    throw new Error('[ADSP-P2] ldp.registry.register no longer matches the pinned SemApps contract');
  }
  const replacement = `options.acceptedTypes &&\n      (process.env.SEMAPPS_MOLECULER_MODE === 'distributed'\n        ? await (() => {\n            const service = this.broker.getLocalService('jsonld.parser');\n            if (!service?.actions?.expandTypes) throw new Error('[ADSP-P2] Local jsonld.parser is not ready');\n            return service.actions.expandTypes({ types: options.acceptedTypes }, { parentCtx: ctx });\n          })()\n        : await ctx.call('jsonld.parser.expandTypes', { types: options.acceptedTypes }))`;
  const replaced = source.replace(ORIGINAL_EXPANSION, replacement);
  return { source: addPatchMarker(replaced), changed: true };
}

function applyPatch() {
  const packageRoot = findPackageRoot();
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (packageJson.version !== EXPECTED_VERSION) {
    throw new Error(`[ADSP-P2] Refusing to patch ${EXPECTED_PACKAGE}@${packageJson.version}; expected exactly ${EXPECTED_VERSION}`);
  }
  const file = path.join(packageRoot, RELATIVE_PATH);
  if (!fs.existsSync(file)) throw new Error(`[ADSP-P2] Missing pinned ldp.registry.register artifact at ${RELATIVE_PATH}`);
  const original = fs.readFileSync(file, 'utf8');
  const result = patchRegisterSource(original);
  if (result.changed) fs.writeFileSync(file, result.source, 'utf8');
  process.stdout.write(`[ADSP-P2] Distributed LDP semantic locality verified; patched ${result.changed ? 1 : 0}\n`);
  return { packageRoot, file, changed: result.changed };
}

if (require.main === module) applyPatch();

module.exports = {
  EXPECTED_PACKAGE,
  EXPECTED_VERSION,
  PATCH_MARKER,
  RELATIVE_PATH,
  ORIGINAL_EXPANSION,
  PATCHED_FRAGMENTS,
  isAlreadyPatched,
  addPatchMarker,
  patchRegisterSource,
  applyPatch
};
