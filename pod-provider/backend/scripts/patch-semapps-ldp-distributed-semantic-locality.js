'use strict';

const fs = require('fs');
const path = require('path');

const EXPECTED_PACKAGE = '@semapps/ldp';
const EXPECTED_VERSION = '1.1.4';
const PATCH_MARKER = 'ADSP-P2_DISTRIBUTED_LDP_SEMANTIC_LOCALITY';
const RELATIVE_PATH = 'services/registry/actions/register.js';

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

function patchRegisterSource(source) {
  if (source.includes(PATCH_MARKER)) return { source, changed: false };
  const needle = "options.acceptedTypes && (await ctx.call('jsonld.parser.expandTypes', { types: options.acceptedTypes }))";
  if (!source.includes(needle) || !source.includes('this.registeredContainers[options.name] = options')) {
    throw new Error('[ADSP-P2] ldp.registry.register no longer matches the pinned SemApps contract');
  }
  const replacement = `options.acceptedTypes &&\n      (process.env.SEMAPPS_MOLECULER_MODE === 'distributed'\n        ? await (() => {\n            const service = this.broker.getLocalService('jsonld.parser');\n            if (!service?.actions?.expandTypes) throw new Error('[ADSP-P2] Local jsonld.parser is not ready');\n            return service.actions.expandTypes({ types: options.acceptedTypes }, { parentCtx: ctx });\n          })()\n        : await ctx.call('jsonld.parser.expandTypes', { types: options.acceptedTypes }))`;
  const patched = source.replace(needle, replacement).replace('const Schema = {', `const Schema = {\n  // ${PATCH_MARKER}`);
  return { source: patched, changed: true };
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
  patchRegisterSource,
  applyPatch
};
