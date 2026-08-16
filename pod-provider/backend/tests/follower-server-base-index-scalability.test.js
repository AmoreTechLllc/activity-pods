'use strict';

const { getDatasetFromUri } = require('@semapps/ldp');
const schema = require('../services/activitypub-follower-server-base-index.service');

function createService(overrides = {}) {
  return {
    settings: schema.settings || {},
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    rebuilds: new Map(),
    pendingMutations: new Map(),
    dirtyCollections: new Set(),
    readyCollections: new Set(),
    ...schema.methods,
    ...overrides
  };
}

describe('FEP-8fcf exact server-base follower projection', () => {
  test('startup invalidates only this projection readiness and does not enumerate accounts', async () => {
    const calls = [];
    const broker = {
      call: jest.fn(async (action, params) => {
        calls.push({ action, params });
      })
    };
    const service = createService({ broker });

    await schema.started.call(service);

    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe('triplestore.update');
    expect(calls[0].params.dataset).toBe('settings');
    expect(calls[0].params.query).toContain('FollowerServerBaseIndexState');
    expect(calls[0].params.query).not.toContain('as:items');
  });

  test('unused exact index stays dormant on follower mutations', async () => {
    const service = createService({
      applyMutation: jest.fn(),
      queueMutation: jest.fn()
    });
    const ctx = { call: jest.fn() };

    await service.handleCollectionMutation(
      ctx,
      'add',
      'https://pods.example/users/alice/followers',
      'https://remote.example/users/bob'
    );

    expect(ctx.call).not.toHaveBeenCalled();
    expect(service.applyMutation).not.toHaveBeenCalled();
    expect(service.queueMutation).not.toHaveBeenCalled();
  });

  test('projection entries preserve scheme and explicit port as an exact key', () => {
    const service = createService();
    const collectionUri = 'https://pods.example/users/alice/followers';

    const httpsDefault = service.renderProjectionEntry(collectionUri, 'https://remote.example/users/a');
    const httpsCustom = service.renderProjectionEntry(collectionUri, 'https://remote.example:8443/users/b');
    const httpCustom = service.renderProjectionEntry(collectionUri, 'http://remote.example:8443/users/c');

    expect(httpsDefault).toContain('apods:serverBaseUri "https://remote.example/"');
    expect(httpsCustom).toContain('apods:serverBaseUri "https://remote.example:8443/"');
    expect(httpCustom).toContain('apods:serverBaseUri "http://remote.example:8443/"');
  });

  test('exact lookup queries only the requested server base and revalidates authority', async () => {
    const collectionUri = 'https://pods.example/users/alice/followers';
    const serverBaseUri = 'https://remote.example:8443/';
    const followerUri = 'https://remote.example:8443/users/bob';
    const authoritativeDataset = getDatasetFromUri(collectionUri);
    const calls = [];
    const service = createService({
      ensureReady: jest.fn(async () => undefined),
      deleteEntries: jest.fn(async () => undefined)
    });
    const ctx = {
      params: { collectionUri, serverBaseUri },
      call: jest.fn(async (action, params) => {
        calls.push({ action, params });
        if (action !== 'triplestore.query') throw new Error(`unexpected action ${action}`);
        if (params.dataset === 'settings') {
          expect(params.query).toContain('apods:serverBaseUri "https://remote.example:8443/"');
          expect(params.query).not.toContain('apods:domain');
          return [{
            entry: { value: service.entryUri(collectionUri, followerUri) },
            followerUri: { value: followerUri }
          }];
        }
        expect(params.dataset).toBe(authoritativeDataset);
        expect(params.query).toContain('VALUES ?followerUri');
        expect(params.query).toContain(`<${followerUri}>`);
        return [{ followerUri: { value: followerUri } }];
      })
    };

    const result = await schema.actions.getForServerBaseUri.handler.call(service, ctx);

    expect(result).toEqual([followerUri]);
    expect(calls.filter(call => call.params.dataset === authoritativeDataset)).toHaveLength(1);
    expect(service.deleteEntries).not.toHaveBeenCalled();
  });

  test('same-host wrong-scheme and wrong-port rows are rejected and cleaned as stale', async () => {
    const collectionUri = 'https://pods.example/users/alice/followers';
    const serverBaseUri = 'https://remote.example:8443/';
    const exact = 'https://remote.example:8443/users/exact';
    const wrongPort = 'https://remote.example/users/wrong-port';
    const wrongScheme = 'http://remote.example:8443/users/wrong-scheme';
    const service = createService({
      ensureReady: jest.fn(async () => undefined),
      queryAuthoritativeMembers: jest.fn(async () => new Set([exact, wrongPort, wrongScheme])),
      deleteEntries: jest.fn(async () => undefined),
      triQuery: jest.fn(async () => [exact, wrongPort, wrongScheme].map(followerUri => ({
        entry: { value: service.entryUri(collectionUri, followerUri) },
        followerUri: { value: followerUri }
      })))
    });
    const ctx = { params: { collectionUri, serverBaseUri }, call: jest.fn() };

    const result = await schema.actions.getForServerBaseUri.handler.call(service, ctx);

    expect(result).toEqual([exact]);
    expect(service.deleteEntries).toHaveBeenCalledWith(ctx, [
      service.entryUri(collectionUri, wrongPort),
      service.entryUri(collectionUri, wrongScheme)
    ]);
  });

  test('authoritative membership validation stays bounded for large exact subsets', async () => {
    const collectionUri = 'https://pods.example/users/alice/followers';
    const authoritativeDataset = getDatasetFromUri(collectionUri);
    const followers = Array.from(
      { length: 1001 },
      (_, index) => `https://remote.example:8443/users/${index}`
    );
    const queries = [];
    const service = createService();
    const ctx = {
      call: jest.fn(async (action, params) => {
        expect(action).toBe('triplestore.query');
        queries.push(params);
        return [];
      })
    };

    const result = await service.queryAuthoritativeMembers(ctx, collectionUri, followers);

    expect(result).toEqual(new Set());
    expect(queries).toHaveLength(3);
    expect(queries.every(query => query.dataset === authoritativeDataset)).toBe(true);
    expect(queries[0].query).toContain('/499>');
    expect(queries[0].query).not.toContain('/500>');
    expect(queries[1].query).toContain('/999>');
    expect(queries[2].query).toContain('/1000>');
  });

  test('first exact query rebuilds with deterministic keyset paging and then marks the collection ready', async () => {
    const collectionUri = 'https://pods.example/users/alice/followers';
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      followerUri: { value: `https://remote.example:8443/users/${String(index).padStart(4, '0')}` }
    }));
    const secondPage = [{
      followerUri: { value: 'https://remote.example:8443/users/0500' }
    }];
    const queryCalls = [];
    const events = [];
    const service = createService({
      clearCollectionProjection: jest.fn(async () => events.push('clear')),
      insertProjectionEntries: jest.fn(async (_ctx, _collectionUri, followers) => {
        events.push(`insert:${followers.length}`);
        return followers.length;
      }),
      drainPendingMutations: jest.fn(async () => events.push('drain')),
      triUpdate: jest.fn(async (_ctx, query) => {
        if (query.includes('apods:ready true')) events.push('ready');
      })
    });
    const ctx = {
      call: jest.fn(async (action, params) => {
        expect(action).toBe('triplestore.query');
        queryCalls.push(params.query);
        if (params.query.includes('FILTER(STR(?followerUri) > "https://remote.example:8443/users/0499")')) {
          return secondPage;
        }
        if (!params.query.includes('FILTER(STR(?followerUri) >')) return firstPage;
        throw new Error(`unexpected cursor query ${params.query}`);
      })
    };

    const count = await service.rebuildCollection(ctx, collectionUri);

    expect(count).toBe(501);
    expect(queryCalls).toHaveLength(2);
    expect(queryCalls[0]).toContain('ORDER BY STR(?followerUri)');
    expect(queryCalls[0]).toContain('LIMIT 500');
    expect(queryCalls[0]).not.toContain('OFFSET');
    expect(queryCalls[1]).toContain('users/0499');
    expect(events).toEqual(['clear', 'insert:500', 'insert:1', 'drain', 'ready', 'drain']);
    expect(service.readyCollections.has(collectionUri)).toBe(true);
  });

  test('ready exact index applies follower mutations without triggering a rebuild', async () => {
    const collectionUri = 'https://pods.example/users/alice/followers';
    const followerUri = 'https://remote.example:8443/users/bob';
    const service = createService({
      applyMutation: jest.fn(async () => undefined)
    });
    service.readyCollections.add(collectionUri);
    const ctx = {
      call: jest.fn(async action => {
        expect(action).toBe('activitypub.collection.getOwner');
        return 'https://pods.example/users/alice';
      })
    };

    await service.handleCollectionMutation(ctx, 'add', collectionUri, followerUri);

    expect(service.applyMutation).toHaveBeenCalledWith(ctx, 'add', collectionUri, followerUri);
    expect(service.readyCollections.has(collectionUri)).toBe(true);
  });
});
