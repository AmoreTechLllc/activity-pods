'use strict';

const fs = require('fs');
const path = require('path');
const schema = require('../services/activitypub-follower-domain-index.service');

function createService(overrides = {}) {
  const service = {
    settings: schema.settings || {},
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    rebuilds: new Map(),
    pendingMutations: new Map(),
    dirtyCollections: new Set(),
    ...schema.methods,
    ...overrides
  };
  return service;
}

describe('follower domain projection scalability', () => {
  test('followers-sync partial endpoint delegates to domain projection instead of scanning all followers', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../services/internal-followers-sync-api.service.js'),
      'utf8'
    );
    const section = source.slice(
      source.indexOf('getPartialCollection:'),
      source.indexOf('getLocalFollowersOfRemote:')
    );

    expect(source).toContain("'activitypub.follower-domain-index'");
    expect(section).toContain("activitypub.follower-domain-index.getForDomain");
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

  test('ready domain lookup starts from exact collection and domain and validates only candidates', async () => {
    const collectionUri = 'https://example.test/users/alice/followers';
    const followerUri = 'https://remote.example/users/bob';
    const calls = [];
    const service = createService({
      isReady: jest.fn(async () => true)
    });
    const ctx = {
      params: { collectionUri, domain: 'REMOTE.EXAMPLE' },
      call: jest.fn(async (action, params) => {
        calls.push({ action, params });
        if (action === 'triplestore.query') {
          return [
            {
              entry: { value: service.entryUri(collectionUri, followerUri) },
              followerUri: { value: followerUri }
            }
          ];
        }
        if (action === 'activitypub.collection.includes') return true;
        throw new Error(`unexpected action ${action}`);
      })
    };

    const result = await schema.actions.getForDomain.handler.call(service, ctx);

    expect(result).toEqual([followerUri]);
    const queryCall = calls.find(call => call.action === 'triplestore.query');
    expect(queryCall.params.query).toContain(`apods:collectionUri ${JSON.stringify(collectionUri)}`);
    expect(queryCall.params.query).toContain('apods:domain "remote.example"');
    expect(queryCall.params.query).not.toContain('as:items ?followerUri');
    expect(calls.filter(call => call.action === 'activitypub.collection.includes')).toHaveLength(1);
  });

  test('first collection lookup rebuilds that collection only and records a ready marker after snapshot', async () => {
    const collectionUri = 'https://example.test/users/alice/followers';
    const followerUri = 'https://remote.example/users/bob';
    const updates = [];
    const service = createService({
      triUpdate: jest.fn(async (_ctx, query) => {
        updates.push(query);
      }),
      drainPendingMutations: jest.fn(async () => undefined)
    });
    const ctx = {
      call: jest.fn(async (action, params) => {
        if (action !== 'triplestore.query') throw new Error(`unexpected action ${action}`);
        expect(params.query).toContain(`<${collectionUri}> as:items ?followerUri`);
        return [{ followerUri: { value: followerUri } }];
      })
    };

    const count = await service.rebuildCollection(ctx, collectionUri);

    expect(count).toBe(1);
    expect(ctx.call).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toContain(JSON.stringify(followerUri));
    expect(updates[1]).toContain('apods:ready true');
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
