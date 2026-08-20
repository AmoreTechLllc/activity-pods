'use strict';

const {
  PATCH_MARKER,
  patchContextGet,
  patchContextGetLocal,
  patchParser,
  patchDocumentLoader
} = require('../scripts/patch-semapps-jsonld-distributed-locality');

const fixtures = {
  contextGet: `
const Schema = {
  async handler(ctx) {
    const ontologies = await ctx.call('ontologies.list');
    const localContext = await this.actions.getLocal({}, { parentCtx: ctx });
    return [ontologies, localContext];
  }
};
`,
  contextGetLocal: `
const Schema = {
  async handler(ctx) {
    let context = [];
    let ontologies = await ctx.call('ontologies.list');
    const prefixes = Object.fromEntries(ontologies.map(ont => [ont.prefix, ont.namespace]));
    context = await ctx.call('jsonld.context.parse', {
      context: [...context, prefixes]
    });
    return { '@context': context };
  }
};
`,
  parser: `
const JsonldParserSchema = {
  async started() {
    this.jsonld.documentLoader = (url, options) =>
      this.broker.call('jsonld.document-loader.loadWithCache', { url, options });
    this.jsonLdParser = new JsonLdParser({
      documentLoader: {
        load: url => this.broker.call('jsonld.document-loader.loadWithCache', { url }).then(context => context.document)
      }
    });
  },
  actions: {
    expandPredicate: { async handler(ctx) { let { context } = ctx.params; if (!context) context = await ctx.call('jsonld.context.get'); return context; } },
    expandTypes: { async handler(ctx) { let { context } = ctx.params; if (!context) context = await ctx.call('jsonld.context.get'); return context; } }
  }
};
`,
  documentLoader: `
const JsonldDocumentLoaderSchema = {
  actions: {
    loadWithCache: {
      async handler(ctx) {
        const { url } = ctx.params;
        if (url === this.settings.localContextUri) {
          return {
            contextUrl: null,
            documentUrl: url,
            document: await ctx.call('jsonld.context.getLocal')
          };
        }
      }
    }
  }
};
`
};

describe('ADSP P2 distributed JSON-LD semantic locality patch', () => {
  test('keeps context ontology lookup local in distributed mode', () => {
    const result = patchContextGet(fixtures.contextGet);
    expect(result.changed).toBe(true);
    expect(result.source).toContain(PATCH_MARKER);
    expect(result.source).toContain("getLocalService('ontologies')");
    expect(result.source).toContain("ctx.call('ontologies.list')");
  });

  test('keeps getLocal ontology and parse operations local', () => {
    const result = patchContextGetLocal(fixtures.contextGetLocal);
    expect(result.source).toContain("getLocalService('ontologies')");
    expect(result.source).toContain('this.actions.parse');
    expect(result.source).toContain("ctx.call('jsonld.context.parse'");
  });

  test('keeps parser context and document-loader dependencies local', () => {
    const result = patchParser(fixtures.parser);
    expect(result.source).toContain("getLocalService('jsonld.document-loader')");
    expect(result.source).toContain("getLocalService('jsonld.context')");
    expect(result.source).toContain("this.broker.call('jsonld.document-loader.loadWithCache'");
    expect(result.source).toContain("ctx.call('jsonld.context.get')");
  });

  test('keeps local-context document loading on local context service', () => {
    const result = patchDocumentLoader(fixtures.documentLoader);
    expect(result.source).toContain("getLocalService('jsonld.context')");
    expect(result.source).toContain("ctx.call('jsonld.context.getLocal')");
  });

  test.each([
    ['context get', patchContextGet, fixtures.contextGet],
    ['context getLocal', patchContextGetLocal, fixtures.contextGetLocal],
    ['parser', patchParser, fixtures.parser],
    ['document loader', patchDocumentLoader, fixtures.documentLoader]
  ])('%s patch is idempotent', (_name, patcher, source) => {
    const first = patcher(source);
    const second = patcher(first.source);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.source).toBe(first.source);
  });

  test('fails closed when parser contract drifts', () => {
    expect(() => patchParser('const JsonldParserSchema = {};')).toThrow(
      /jsonld\.parser no longer matches the pinned SemApps contract/u
    );
  });
});
