'use strict';

const {
  PATCH_MARKER,
  patchRegisterSource
} = require('../scripts/patch-semapps-ldp-distributed-semantic-locality');

function fixture() {
  return `
const Schema = {
  visibility: 'public',
  async handler(ctx) {
    let options = { ...ctx.params };
    options.acceptedTypes =
      options.acceptedTypes && (await ctx.call('jsonld.parser.expandTypes', { types: options.acceptedTypes }));
    this.registeredContainers[options.name] = options;
    return options;
  }
};
`;
}

describe('ADSP P2 distributed LDP semantic locality patch', () => {
  test('routes accepted-type expansion to local parser only in distributed mode', () => {
    const result = patchRegisterSource(fixture());
    expect(result.changed).toBe(true);
    expect(result.source).toContain(PATCH_MARKER);
    expect(result.source).toContain("process.env.SEMAPPS_MOLECULER_MODE === 'distributed'");
    expect(result.source).toContain("this.broker.getLocalService('jsonld.parser')");
    expect(result.source).toContain('service.actions.expandTypes');
    expect(result.source).toContain("ctx.call('jsonld.parser.expandTypes'");
  });

  test('is idempotent', () => {
    const first = patchRegisterSource(fixture());
    const second = patchRegisterSource(first.source);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.source).toBe(first.source);
  });

  test('recognizes a markerless artifact that already contains the distributed rewrite', () => {
    const first = patchRegisterSource(fixture());
    const markerless = first.source.replace(`// ${PATCH_MARKER}`, '');
    const second = patchRegisterSource(markerless);
    expect(second.changed).toBe(false);
    expect(second.source).toBe(markerless);
  });

  test('still fails closed on partial or structurally drifted rewrites', () => {
    const first = patchRegisterSource(fixture());
    const markerlessPartial = first.source
      .replace(`// ${PATCH_MARKER}`, '')
      .replace("this.broker.getLocalService('jsonld.parser')", "this.broker.getLocalService('jsonld.context')");
    expect(() => patchRegisterSource(markerlessPartial)).toThrow(
      /ldp\.registry\.register no longer matches the pinned SemApps contract/u
    );
  });

  test('fails closed on structural drift', () => {
    expect(() => patchRegisterSource('const Schema = {};')).toThrow(
      /ldp\.registry\.register no longer matches the pinned SemApps contract/u
    );
  });
});
