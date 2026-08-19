'use strict';

const vm = require('vm');
const {
  PATCH_MARKER,
  PATCH_REVALIDATION_CONTRACT,
  assertParsableJavaScript,
  isPatchedSpecialEndpointCandidate,
  isSpecialEndpointCandidate,
  patchSpecialEndpointSource
} = require('../scripts/patch-semapps-ldp-special-endpoint-race');

const PINNED_SOURCE = `
module.exports = {
  settings: {
    baseUrl: null,
    settingsDataset: null,
    endpoint: { path: null, initialData: {} }
  },
  async started() {
    this.endpointUrl = urlJoin(this.settings.baseUrl, this.settings.endpoint.path);
    const endpointExist = await this.broker.call(
      'ldp.resource.exist',
      { resourceUri: this.endpointUrl, webId: 'system' },
      { meta: { dataset: this.settings.settingsDataset } }
    );
    if (!endpointExist) {
      await this.broker.call(
        'ldp.resource.create',
        {
          resource: {
            id: this.endpointUrl,
            ...this.settings.endpoint.initialData
          },
          contentType: MIME_TYPES.JSON,
          webId: 'system'
        },
        { meta: { dataset: this.settings.settingsDataset, skipEmitEvent: true, skipObjectsWatcher: true } }
      );
    }
  }
};
`;

describe('SemApps special-endpoint horizontal startup patch', () => {
  test('recognizes the pinned SemApps v1.1.4 special-endpoint contract', () => {
    expect(isSpecialEndpointCandidate(PINNED_SOURCE)).toBe(true);
  });

  test('suppresses only the exact already-exists create race after authoritative revalidation', () => {
    const result = patchSpecialEndpointSource(PINNED_SOURCE);
    expect(result.changed).toBe(true);
    expect(result.source).toContain(PATCH_MARKER);
    expect(result.source).toContain(PATCH_REVALIDATION_CONTRACT);
    expect(isPatchedSpecialEndpointCandidate(result.source)).toBe(true);
    expect(result.source).toContain("error.code === 400");
    expect(result.source).toContain("error.type === 'BAD_REQUEST'");
    expect(result.source).toContain('error.message === `A resource already exist with URI ${this.endpointUrl}`');
    expect(result.source).toContain('if (!adspP2IsCreateConflict) throw error;');
    expect(result.source).toContain("'ldp.resource.create'");
    expect(result.source.match(/'ldp\.resource\.exist'/gu)).toHaveLength(2);
    expect(result.source).toContain('Special endpoint already initialized by another replica');
    expect(result.source).not.toMatch(/await\s+\/\* ADSP-P2_IDEMPOTENT_SPECIAL_ENDPOINT_STARTUP \*\/\s*try/u);
    expect(() => new vm.Script(result.source)).not.toThrow();
  });

  test('is idempotent when postinstall runs more than once', () => {
    const once = patchSpecialEndpointSource(PINNED_SOURCE);
    const twice = patchSpecialEndpointSource(once.source);
    expect(twice.changed).toBe(false);
    expect(twice.source).toBe(once.source);
    expect(() => new vm.Script(twice.source)).not.toThrow();
  });

  test('fails closed when the upstream artifact drifts', () => {
    expect(() => patchSpecialEndpointSource('module.exports = {};')).toThrow(
      /no longer matches the expected v1\.1\.4 contract/u
    );
  });

  test('parser guard fails closed before an invalid dependency artifact can be written', () => {
    expect(() => assertParsableJavaScript('async function broken() { await try {} }', 'broken.js')).toThrow(
      /Refusing to write syntactically invalid patched broken\.js/u
    );
  });

  test('fails closed if the reviewed create call is no longer directly awaited', () => {
    const drifted = PINNED_SOURCE.replace("await this.broker.call(\n        'ldp.resource.create'", "this.broker.call(\n        'ldp.resource.create'");
    expect(() => patchSpecialEndpointSource(drifted)).toThrow(/no longer directly awaited as reviewed/u);
  });

  test('fails closed when an existing marker broadens conflict classification', () => {
    const patched = patchSpecialEndpointSource(PINNED_SOURCE).source;
    const broadContract = PATCH_REVALIDATION_CONTRACT.replace(
      "error.type === 'BAD_REQUEST' &&\n          error.message === `A resource already exist with URI ${this.endpointUrl}`;",
      "error.type === 'BAD_REQUEST';"
    );
    const drifted = patched.replace(PATCH_REVALIDATION_CONTRACT, broadContract);
    expect(isPatchedSpecialEndpointCandidate(drifted)).toBe(false);
    expect(() => patchSpecialEndpointSource(drifted)).toThrow(/marker no longer matches the reviewed repair contract/u);
  });

  test('fails closed when an existing marker remains but exact post-race dataset revalidation drifts', () => {
    const patched = patchSpecialEndpointSource(PINNED_SOURCE).source;
    const wrongContract = PATCH_REVALIDATION_CONTRACT.replace(
      '{ meta: { dataset: this.settings.settingsDataset } }',
      "{ meta: { dataset: 'settings' } }"
    );
    const drifted = patched.replace(PATCH_REVALIDATION_CONTRACT, wrongContract);
    expect(isPatchedSpecialEndpointCandidate(drifted)).toBe(false);
    expect(() => patchSpecialEndpointSource(drifted)).toThrow(/marker no longer matches the reviewed repair contract/u);
  });

  test('fails closed when an existing marker remains but exact post-race URI revalidation drifts', () => {
    const patched = patchSpecialEndpointSource(PINNED_SOURCE).source;
    const wrongContract = PATCH_REVALIDATION_CONTRACT.replace(
      "{ resourceUri: this.endpointUrl, webId: 'system' }",
      "{ resourceUri: this.settings.baseUrl, webId: 'system' }"
    );
    const drifted = patched.replace(PATCH_REVALIDATION_CONTRACT, wrongContract);
    expect(isPatchedSpecialEndpointCandidate(drifted)).toBe(false);
    expect(() => patchSpecialEndpointSource(drifted)).toThrow(/marker no longer matches the reviewed repair contract/u);
  });
});
