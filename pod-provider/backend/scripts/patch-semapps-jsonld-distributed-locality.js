'use strict';

const fs = require('fs');
const path = require('path');

const EXPECTED_PACKAGE = '@semapps/jsonld';
const EXPECTED_VERSION = '1.1.4';
const PATCH_MARKER = 'ADSP-P2_DISTRIBUTED_JSONLD_LOCALITY';

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

function replaceExactly(source, needle, replacement, label, expectedCount = 1) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = source.indexOf(needle, offset);
    if (index === -1) break;
    count += 1;
    offset = index + needle.length;
  }
  if (count !== expectedCount) {
    throw new Error(`[ADSP-P2] Expected exactly ${expectedCount} ${label} occurrence(s), found ${count}`);
  }
  return source.split(needle).join(replacement);
}

function patchContextGet(source) {
  if (source.includes(PATCH_MARKER)) return { source, changed: false };
  if (!source.includes("ctx.call('ontologies.list')") || !source.includes('this.actions.getLocal')) {
    throw new Error('[ADSP-P2] jsonld.context.get no longer matches the pinned SemApps contract');
  }
  const replacement = `process.env.SEMAPPS_MOLECULER_MODE === 'distributed'\n      ? await (() => {\n          const service = this.broker.getLocalService('ontologies');\n          if (!service?.actions?.list) throw new Error('[ADSP-P2] Local ontologies.list is not ready');\n          return service.actions.list({}, { parentCtx: ctx });\n        })()\n      : await ctx.call('ontologies.list')`;
  let patched = replaceExactly(
    source,
    "await ctx.call('ontologies.list')",
    replacement,
    'jsonld.context.get ontologies.list'
  );
  patched = patched.replace('const Schema = {', `const Schema = {\n  // ${PATCH_MARKER}`);
  return { source: patched, changed: true };
}

function patchContextGetLocal(source) {
  if (source.includes(PATCH_MARKER)) return { source, changed: false };
  if (!source.includes("ctx.call('ontologies.list')") || !source.includes("ctx.call('jsonld.context.parse'")) {
    throw new Error('[ADSP-P2] jsonld.context.getLocal no longer matches the pinned SemApps contract');
  }
  const ontologyReplacement = `process.env.SEMAPPS_MOLECULER_MODE === 'distributed'\n      ? await (() => {\n          const service = this.broker.getLocalService('ontologies');\n          if (!service?.actions?.list) throw new Error('[ADSP-P2] Local ontologies.list is not ready');\n          return service.actions.list({}, { parentCtx: ctx });\n        })()\n      : await ctx.call('ontologies.list')`;
  let patched = replaceExactly(
    source,
    "await ctx.call('ontologies.list')",
    ontologyReplacement,
    'jsonld.context.getLocal ontologies.list'
  );
  const parseNeedle = "context = await ctx.call('jsonld.context.parse', {\n      context: [...context, prefixes]\n    });";
  const parseReplacement = `context = process.env.SEMAPPS_MOLECULER_MODE === 'distributed'\n      ? await this.actions.parse({ context: [...context, prefixes] }, { parentCtx: ctx })\n      : await ctx.call('jsonld.context.parse', {\n          context: [...context, prefixes]\n        });`;
  patched = replaceExactly(patched, parseNeedle, parseReplacement, 'jsonld.context.getLocal parse');
  patched = patched.replace('const Schema = {', `const Schema = {\n  // ${PATCH_MARKER}`);
  return { source: patched, changed: true };
}

function patchParser(source) {
  if (source.includes(PATCH_MARKER)) return { source, changed: false };
  const loaderNeedle = "this.broker.call('jsonld.document-loader.loadWithCache', { url, options })";
  const streamingNeedle = "this.broker.call('jsonld.document-loader.loadWithCache', { url }).then(context => context.document)";
  const contextNeedle = "if (!context) context = await ctx.call('jsonld.context.get');";
  if (!source.includes(loaderNeedle) || !source.includes(streamingNeedle) || !source.includes(contextNeedle)) {
    throw new Error('[ADSP-P2] jsonld.parser no longer matches the pinned SemApps contract');
  }
  const loaderReplacement = `process.env.SEMAPPS_MOLECULER_MODE === 'distributed'\n        ? (() => {\n            const service = this.broker.getLocalService('jsonld.document-loader');\n            if (!service?.actions?.loadWithCache) throw new Error('[ADSP-P2] Local jsonld.document-loader is not ready');\n            return service.actions.loadWithCache({ url, options });\n          })()\n        : this.broker.call('jsonld.document-loader.loadWithCache', { url, options })`;
  const streamingReplacement = `process.env.SEMAPPS_MOLECULER_MODE === 'distributed'\n          ? (() => {\n              const service = this.broker.getLocalService('jsonld.document-loader');\n              if (!service?.actions?.loadWithCache) throw new Error('[ADSP-P2] Local jsonld.document-loader is not ready');\n              return service.actions.loadWithCache({ url }).then(context => context.document);\n            })()\n          : this.broker.call('jsonld.document-loader.loadWithCache', { url }).then(context => context.document)`;
  const contextReplacement = `if (!context) {\n          if (process.env.SEMAPPS_MOLECULER_MODE === 'distributed') {\n            const service = this.broker.getLocalService('jsonld.context');\n            if (!service?.actions?.get) throw new Error('[ADSP-P2] Local jsonld.context is not ready');\n            context = await service.actions.get({}, { parentCtx: ctx });\n          } else {\n            context = await ctx.call('jsonld.context.get');\n          }\n        }`;
  let patched = replaceExactly(source, loaderNeedle, loaderReplacement, 'jsonld.parser document loader');
  patched = replaceExactly(patched, streamingNeedle, streamingReplacement, 'jsonld.parser streaming document loader');
  patched = replaceExactly(patched, contextNeedle, contextReplacement, 'jsonld.parser context lookup', 2);
  patched = patched.replace('const JsonldParserSchema = {', `const JsonldParserSchema = {\n  // ${PATCH_MARKER}`);
  return { source: patched, changed: true };
}

function patchDocumentLoader(source) {
  if (source.includes(PATCH_MARKER)) return { source, changed: false };
  const needle = "document: await ctx.call('jsonld.context.getLocal')";
  if (!source.includes(needle) || !source.includes('url === this.settings.localContextUri')) {
    throw new Error('[ADSP-P2] jsonld.document-loader no longer matches the pinned SemApps contract');
  }
  const replacement = `document: process.env.SEMAPPS_MOLECULER_MODE === 'distributed'\n              ? await (() => {\n                  const service = this.broker.getLocalService('jsonld.context');\n                  if (!service?.actions?.getLocal) throw new Error('[ADSP-P2] Local jsonld.context is not ready');\n                  return service.actions.getLocal({}, { parentCtx: ctx });\n                })()\n              : await ctx.call('jsonld.context.getLocal')`;
  let patched = replaceExactly(source, needle, replacement, 'jsonld.document-loader local context');
  patched = patched.replace('const JsonldDocumentLoaderSchema = {', `const JsonldDocumentLoaderSchema = {\n  // ${PATCH_MARKER}`);
  return { source: patched, changed: true };
}

const TARGETS = [
  ['services/context/actions/get.js', patchContextGet, 'jsonld.context.get'],
  ['services/context/actions/getLocal.js', patchContextGetLocal, 'jsonld.context.getLocal'],
  ['services/parser/index.js', patchParser, 'jsonld.parser'],
  ['services/document-loader/index.js', patchDocumentLoader, 'jsonld.document-loader']
];

function applyPatch() {
  const packageRoot = findPackageRoot();
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (packageJson.version !== EXPECTED_VERSION) {
    throw new Error(`[ADSP-P2] Refusing to patch ${EXPECTED_PACKAGE}@${packageJson.version}; expected exactly ${EXPECTED_VERSION}`);
  }
  const results = TARGETS.map(([relativePath, patcher, name]) => {
    const file = path.join(packageRoot, relativePath);
    if (!fs.existsSync(file)) throw new Error(`[ADSP-P2] Missing pinned ${name} artifact at ${relativePath}`);
    const original = fs.readFileSync(file, 'utf8');
    const result = patcher(original);
    if (result.changed) fs.writeFileSync(file, result.source, 'utf8');
    return { name, file, changed: result.changed };
  });
  process.stdout.write(`[ADSP-P2] Distributed JSON-LD semantic locality verified for ${results.length} pinned artifact(s); patched ${results.filter(r => r.changed).length}\n`);
  return { packageRoot, results };
}

if (require.main === module) applyPatch();

module.exports = {
  EXPECTED_PACKAGE,
  EXPECTED_VERSION,
  PATCH_MARKER,
  replaceExactly,
  patchContextGet,
  patchContextGetLocal,
  patchParser,
  patchDocumentLoader,
  applyPatch
};
