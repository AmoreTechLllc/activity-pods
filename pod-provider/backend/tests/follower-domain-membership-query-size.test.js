'use strict';

const { getDatasetFromUri } = require('@semapps/ldp');
const schema = require('../services/activitypub-follower-domain-index.service');

function createService() {
  return {
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    rebuilds: new Map(),
    pendingMutations: new Map(),
    dirtyCollections: new Set(),
    ...schema.methods
  };
}

describe('follower domain authoritative membership query sizing', () => {
  test('long valid follower URIs are split before a VALUES payload can grow beyond the configured bound', async () => {
    const collectionUri = 'https://example.test/users/alice/followers';
    const authoritativeDataset = getDatasetFromUri(collectionUri);
    const followers = Array.from({ length: 40 }, (_, index) => {
      const suffix = String(index).padStart(3, '0');
      return `https://remote.example/users/${'x'.repeat(3850)}${suffix}`;
    });
    const queries = [];
    const service = createService();
    const ctx = {
      call: jest.fn(async (action, params) => {
        expect(action).toBe('triplestore.query');
        queries.push(params);
        return [];
      })
    };

    await service.queryAuthoritativeMembers(ctx, collectionUri, followers);

    expect(queries.length).toBeGreaterThan(1);
    expect(queries.every(query => query.dataset === authoritativeDataset)).toBe(true);
    expect(queries.every(query => query.query.length < 66_500)).toBe(true);
    expect(queries.flatMap(query => query.query.match(/https:\/\/remote\.example\/users\//g) || [])).toHaveLength(40);
  });
});
