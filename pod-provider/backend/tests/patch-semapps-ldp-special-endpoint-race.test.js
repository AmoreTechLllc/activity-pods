'use strict';

const {
  PATCH_MARKER,
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

  test('turns only the create race into a revalidated idempotent success', () => {
    const result = patchSpecialEndpointSource(PINNED_SOURCE);
    expect(result.changed).toBe(true);
    expect(result.source).toContain(PATCH_MARKER);
    expect(result.source).toContain("'ldp.resource.create'");
    expect(result.source.match(/'ldp\.resource\.exist'/gu)).toHaveLength(2);
    expect(result.source).toContain('if (!adspP2EndpointExistsAfterCreateRace) throw error');
    expect(result.source).toContain("{ resourceUri: this.endpointUrl, webId: 'system' }");
    expect(result.source).toContain('Special endpoint already initialized by another replica');
  });

  test('is idempotent when postinstall runs more than once', () => {
    const once = patchSpecialEndpointSource(PINNED_SOURCE);
    const twice = patchSpecialEndpointSource(once.source);
    expect(twice.changed).toBe(false);
    expect(twice.source).toBe(once.source);
  });

  test('fails closed when the upstream artifact drifts', () => {
    expect(() => patchSpecialEndpointSource('module.exports = {};')).toThrow(
      /no longer matches the expected v1\.1\.4 contract/u
    );
  });
});
