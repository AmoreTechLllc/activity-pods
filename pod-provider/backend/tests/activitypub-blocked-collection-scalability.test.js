const fs = require('fs');
const path = require('path');

const schema = require('../services/activitypub-blocked-collection.service');

const source = fs.readFileSync(
  path.join(__dirname, '../services/activitypub-blocked-collection.service.js'),
  'utf8'
);

describe('activitypub.blocked LDP/SPARQL scalability', () => {
  test('collection bootstrap resolves both attached collection URIs with one actor read', () => {
    const section = source.slice(
      source.indexOf('async ensureCollectionsForActor'),
      source.indexOf('async ensureCollectionMetadata')
    );

    const actorGets = section.match(/activitypub\.actor\.get/g) || [];
    expect(actorGets).toHaveLength(1);
    expect(section).not.toContain('resolveBlockedCollectionUri(ctx, actorUri)');
    expect(section).not.toContain('resolveBlocksCollectionUri(ctx, actorUri)');
    expect(section).toContain('return { blockedCollectionUri, blocksCollectionUri, dataset };');
  });

  test('known blocked sharing state avoids a duplicate triplestore read', async () => {
    const getState = jest.fn(async () => {
      throw new Error('sharing state should not be re-read');
    });
    const calls = [];
    const service = {
      ...schema.methods,
      settings: {
        blockedFollowersCollectionOptions: {
          path: '/followers',
          permissions: {}
        }
      },
      getBlockedCollectionSharingStateByCollectionUri: getState
    };
    const knownState = {
      collectionUri: 'https://example.test/alice/blocked',
      public: true,
      followersCollectionUri: 'https://example.test/alice/blocked/followers'
    };
    const ctx = {
      call: jest.fn(async (action, params, options) => {
        calls.push({ action, params, options });
        if (action === 'activitypub.collection.exist') return true;
        return undefined;
      })
    };

    const result = await service.ensureBlockedFollowersCollection(
      ctx,
      'https://example.test/alice/blocked',
      'https://example.test/alice',
      'alice',
      knownState
    );

    expect(result).toBe('https://example.test/alice/blocked/followers');
    expect(getState).not.toHaveBeenCalled();
    expect(ctx.call).toHaveBeenCalledWith(
      'activitypub.collection.exist',
      expect.objectContaining({ resourceUri: 'https://example.test/alice/blocked/followers' }),
      { meta: { dataset: 'alice' } }
    );
    expect(calls.some(call => call.action === 'ldp.resource.patch')).toBe(true);
  });

  test('public-state transition reuses bootstrap URI and dataset rather than re-resolving the actor', () => {
    const section = source.slice(
      source.indexOf('async setBlockedCollectionPublicState'),
      source.indexOf('async mutateBlockCollections')
    );

    expect(section).toContain('const ensured = await this.ensureCollectionsForActor(ctx, actorUri);');
    expect(section).toContain('const blockedCollectionUri = ensured.blockedCollectionUri;');
    expect(section).toContain('const dataset = ensured.dataset;');
    expect(section).not.toContain('resolveBlockedCollectionUri(ctx, actorUri)');
  });
});
