'use strict';

const {
  PATCH_MARKER,
  isSpecialEndpointCandidate,
  patchSpecialEndpointSource
} = require('../scripts/patch-semapps-ldp-special-endpoint-race');

const PINNED_SOURCE = `
module.exports = {
  settings: { path: '/.well-known/solid', settingsDataset: 'settings' },
  async started() {
    const resourceUri = urlJoin(this.settings.baseUrl, this.settings.path);
    try {
      const resourceExist = await this.broker.call(
        'ldp.resource.exist',
        { resourceUri },
        { meta: { webId: 'system', dataset: this.settings.settingsDataset } }
      );
      if (!resourceExist) {
        const resource = await this.settings.get(this.broker);
        await this.broker.call(
          'ldp.resource.create',
          { resource, resourceUri },
          { meta: { webId: 'system', dataset: this.settings.settingsDataset } }
        );
      }
    } catch (e) {
      this.logger.error(e);
      throw e;
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
    expect(result.source).toContain('if (!adspP2ResourceExistsAfterCreateRace) throw error');
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
