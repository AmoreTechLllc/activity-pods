'use strict';

const fs = require('fs');
const path = require('path');
const { getDatasetFromUri } = require('@semapps/ldp');
const schema = require('../services/activitypub-follower-domain-index.service');

function createService(overrides = {}) {
  return {
    settings: schema.settings || {},
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    rebuilds: new Map(),
    pendingMutations: new Map(),
    dirtyCollections: new Set(),
    ...schema.methods,
    ...overrides
  };
}

describe('follower domain projection scalability', () => {
  test('followers-sync partial endpoint delegates to domain projection instead of scanning all followers', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/internal-followers-sync-api.service.js'), 'utf8');
    const section = source.slice(source.indexOf('getPartialCollection:'), source.indexOf('getLocalFollowersOfRemote:'));

    expect(source).toContain("'activitypub.follower-domain-index'");
    expect(section).toContain('activitypub.follower-domain-index.getForDomain');
    expect(section).not.toContain('queryCollectionItems(ctx, actor.followers)');
    expect(section).not.toContain('allFollowers.filter');
  });

  test('startup invalidates only readiness markers and never enumerates accounts or follower populations', async () => {
    const calls = [];
    const broker = {
      call: jest.fn(async (action, params) => {
        calls.push({ action, params });
        return undefined;
      })
    };
    const service = createService({ broker });

    await schema.started.call(service);

    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe('triplestore.update');
    expect(calls[0].params.dataset).toBe('settings');
    expect(calls[0].params.query).toContain('FollowerDomainIndexState');
    expect(calls.some(call => call.action === 'auth.account.find')).toBe(false);
    expect(calls[0].params.query).not.toContain('as:items');
  });

  test('readiness lookup uses SELECT bindings compatible with SemApps triplestore.query', async () => {
    const collectionUri = 'https://example.test/users/alice/followers';
    const queries = [];
    const service = createService({
      triQuery: jest.fn(async (_ctx, query) => {
        queries.push(query);
        return [{ ready: { value: 'true' } }];
      })
    });

    const ready = await service.isReady({ call: jest.fn() }, collectionUri);

    expect(ready).toBe(true);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('SELECT ?ready');
    expect(queries[0]).toContain('FILTER(?ready = true)');
    expect(queries[0]).toContain('LIMIT 1');
    expect(queries[0]).not.toContain('ASK');
  });

  test('ready domain lookup validates candidates with one authoritative VALUES query instead of per-item includes', async () => {
    const collectionUri = 'https://example.test/users/alice/followers';
    const authoritativeDataset = getDatasetFromUri(collectionUri);
    const firstFollower = 'https://remote.example/users/bob';
    const staleFollower = 'https://remote.example/users/stale';
    const calls = [];
    const service = createService({
      isReady: jest.fn(async () => true),
      deleteEntries: jest.fn(async () => undefined)
    });
    const ctx = {
      params: { collectionUri, domain: 'REMOTE.EXAMPLE' },
      call: jest.fn(async (action, params) => {
        calls.push({ action, params });
        if (action !== 'triplestore.query') throw new Error(`unexpected action ${action}`);
        if (params.dataset === 'settings') {
          return [
            { entry: { value: service.entryUri(collectionUri, firstFollower) }, followerUri: { value: firstFollower } },
            { entry: { value: service.entryUri(collectionUri, staleFollower) }, followerUri: { value: staleFollower } }
          ];
        }
        expect(params.dataset).toBe(authoritativeDataset);
        expect(params.query).toContain('VALUES ?followerUri');
        expect(params.query).toContain(`<${firstFollower}>`);
        expect(params.query).toContain(`<${staleFollower}>`);
        expect(params.query).toContain(`<${collectionUri}> as:items ?followerUri`);
        return [{ followerUri: { value: firstFollower } }];
      })
    };

    const result = await schema.actions.getForDomain.handler.call(service, ctx);

    expect(result).toEqual([firstFollower]);
    const settingsQuery = calls.find(call => call.action === 'triplestore.query' && call.params.dataset === 'settings');
    expect(settingsQuery.params.query).toContain(`apods:collectionUri ${JSON.stringify(collectionUri)}`);
    expect(settingsQuery.params.query).toContain('apods:domain "remote.example"');
    expect(settingsQuery.params.query).not.toContain('as:items ?followerUri');
    expect(calls.filter(call => call.action === 'triplestore.query' && call.params.dataset === authoritativeDataset)).toHaveLength(1);
    expect(calls.filter(call => call.action === 'activitypub.collection.includes')).toHaveLength(0);
    expect(service.deleteEntries).toHaveBeenCalledWith(ctx, [service.entryUri(collectionUri, staleFollower)]);
  });

  test('authoritative validation keeps VALUES requests bounded for large same-domain subsets', async () => {
    const collectionUri = 'https://example.test/users/alice/followers';
    const authoritativeDataset = getDatasetFromUri(collectionUri);
    const followers = Array.from({ length: 1001 }, (_, index) => `https://remote.example/users/${index}`);
    const queries = [];
    const service = createService();
    const ctx = {
      call: jest.fn(async (action, params) => {
        if (action !== 'triplestore.query') throw new Error(`unexpected action ${action}`);
        queries.push(params);
        return [];
      })
    };

    const result = await service.queryAuthoritativeMembers(ctx, collectionUri, followers);

    expect(result).toEqual(new Set());
    expect(queries).toHaveLength(3);
    expect(queries.every(query => query.dataset === authoritativeDataset)).toBe(true);
    expect(queries.every(query => query.query.includes('VALUES ?followerUri'))).toBe(true);
    expect(queries[0].query).toContain('<https://remote.example/users/499>');
    expect(queries[0].query).not.toContain('<https://remote.example/users/500>');
    expect(queries[1].query).toContain('<https://remote.example/users/999>');
    expect(queries[2].query).toContain('<https://remote.example/users/1000>');
  });

  test('authoritative rebuild page uses deterministic keyset paging rather than OFFSET or unbounded SELECT', async () => {
    const collectionUri = 'https://example.test/users/alice/followers';
    const dataset = getDatasetFromUri(collectionUri);
    const calls = [];
    const service = createService();
    const ctx = {
      call: jest.fn(async (action, params) => {
        calls.push({ action, params });
        return [];
      })
    };

    await service.queryFollowerPage(ctx, collectionUri, dataset, 'https://remote.example/users/0500');

    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe('triplestore.query');
    expect(calls[0].params.dataset).toBe(dataset);
    expect(calls[0].params.query).toContain(`<${collectionUri}> as:items ?followerUri`);
    expect(calls[0].params.query).toContain('FILTER(isIRI(?followerUri))');
    expect(calls[0].params.query).toContain('FILTER(STR(?followerUri) > "https://remote.example/users/0500")');
    expect(calls[0].params.query).toContain('ORDER BY STR(?followerUri)');
    expect(calls[0].params.query).toContain('LIMIT 500');
    expect(calls[0].params.query).not.toContain('OFFSET');
  });

  test('rebuild clears partial state, advances the real keyset cursor, and publishes ready after mutation replay', async () => {
    const collectionUri = 'https://example.test/users/alice/followers';
    const dataset = getDatasetFromUri(collectionUri);
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      followerUri: { value: `https://remote.example/users/${String(index).padStart(4, '0')}` }
    }));
    const secondPage = [{ followerUri: { value: 'https://remote.example/users/0500' } }];
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
        expect(params.dataset).toBe(dataset);
        queryCalls.push(params.query);
        if (params.query.includes('FILTER(STR(?followerUri) > "https://remote.example/users/0499")')) {
          return secondPage;
        }
        if (!params.query.includes('FILTER(STR(?followerUri) >')) return firstPage;
        throw new Error(`unexpected rebuild cursor query: ${params.query}`);
      })
    };

    const count = await service.rebuildCollection(ctx, collectionUri);

    expect(count).toBe(501);
    expect(queryCalls).toHaveLength(2);
    expect(queryCalls[0]).not.toContain('FILTER(STR(?followerUri) >');
    expect(queryCalls[1]).toContain('FILTER(STR(?followerUri) > "https://remote.example/users/0499")');
    expect(service.insertProjectionEntries).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['clear', 'insert:500', 'insert:1', 'drain', 'ready', 'drain']);
    expect(service.dirtyCollections.has(collectionUri)).toBe(false);
  });

  test('projection insert batches bound both item count and rendered update size', async () => {
    const collectionUri = 'https://example.test/users/alice/followers';
    const followers = Array.from({ length: 501 }, (_, index) => `https://remote.example/users/${index}`);
    const updates = [];
    const service = createService({
      triUpdate: jest.fn(async (_ctx, query) => updates.push(query))
    });

    const count = await service.insertProjectionEntries({}, collectionUri, followers);

    const entryCounts = updates.map(query => (query.match(/apods:followerUri /g) || []).length);
    const rendered = updates.join('\n');

    expect(count).toBe(501);
    expect(updates.length).toBeGreaterThanOrEqual(3);
    expect(updates.every(query => query.includes('INSERT DATA'))).toBe(true);
    expect(updates.every(query => query.length < 66_500)).toBe(true);
    expect(entryCounts.every(batchCount => batchCount > 0 && batchCount <= 250)).toBe(true);
    expect(entryCounts.reduce((total, batchCount) => total + batchCount, 0)).toBe(501);
    expect(entryCounts.slice(0, -1).some(batchCount => batchCount < 250)).toBe(true);
    for (const followerUri of followers) {
      expect(rendered).toContain(JSON.stringify(followerUri));
    }
  });

  test('small rebuild remains bounded and records ready after snapshot projection', async () => {
    const collectionUri = 'https://example.test/users/alice/followers';
    const followerUri = 'https://remote.example/users/bob';
    const updates = [];
    const service = createService({
      triUpdate: jest.fn(async (_ctx, query) => updates.push(query)),
      drainPendingMutations: jest.fn(async () => undefined)
    });
    const ctx = {
      call: jest.fn(async (action, params) => {
        if (action !== 'triplestore.query') throw new Error(`unexpected action ${action}`);
        expect(params.query).toContain(`<${collectionUri}> as:items ?followerUri`);
        expect(params.query).toContain('LIMIT 500');
        return [{ followerUri: { value: followerUri } }];
      })
    };

    const count = await service.rebuildCollection(ctx, collectionUri);

    expect(count).toBe(1);
    expect(ctx.call).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(3);
    expect(updates[0]).toContain('DELETE');
    expect(updates[1]).toContain(JSON.stringify(followerUri));
    expect(updates[2]).toContain('apods:ready true');
    expect(service.drainPendingMutations).toHaveBeenCalledTimes(2);
  });

  test('collection mutation failure marks the collection dirty for authoritative rebuild', async () => {
    const collectionUri = 'https://example.test/users/alice/followers';
    const followerUri = 'https://remote.example/users/bob';
    const service = createService({
      applyMutation: jest.fn(async () => {
        throw new Error('settings unavailable');
      })
    });
    const ctx = {
      call: jest.fn(async action => {
        if (action === 'activitypub.collection.getOwner') return 'https://example.test/users/alice';
        throw new Error(`unexpected action ${action}`);
      })
    };

    await service.handleCollectionMutation(ctx, 'add', collectionUri, followerUri);

    expect(service.dirtyCollections.has(collectionUri)).toBe(true);
    expect(service.logger.warn).toHaveBeenCalled();
  });
});
