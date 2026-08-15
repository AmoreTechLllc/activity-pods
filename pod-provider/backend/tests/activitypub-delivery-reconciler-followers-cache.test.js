'use strict';

process.env.SEMAPPS_AVAILABLE_LOCALES ||= 'en';
process.env.SEMAPPS_AUTH_RESERVED_USER_NAMES ||= 'admin';

const service = require('../services/activitypub-delivery-reconciler.service');

function expansionContext() {
  return {
    settings: { baseUri: 'https://pods.example' },
    logger: { debug: jest.fn(), warn: jest.fn() }
  };
}

test('reuses the sender followers expansion within one reconciliation cache', async () => {
  const cache = new Map();
  const collectionGet = jest.fn(async () => ({
    id: 'https://pods.example/alice/followers',
    type: 'Collection',
    items: ['https://remote.example/users/bob', 'https://remote.example/users/carol']
  }));
  const ctx = {
    call: jest.fn(async action => {
      if (action === 'activitypub.collection.get') return collectionGet();
      throw new Error(`Unexpected call ${action}`);
    })
  };
  const activity = { actor: 'https://pods.example/alice' };
  const recipients = ['https://pods.example/alice/followers/'];
  const context = expansionContext();

  const first = await service.methods.expandConcreteRecipients.call(context, ctx, activity, recipients, 'alice', cache);
  const second = await service.methods.expandConcreteRecipients.call(context, ctx, activity, recipients, 'alice', cache);

  expect(first).toEqual(['https://remote.example/users/bob', 'https://remote.example/users/carol']);
  expect(second).toEqual(first);
  expect(collectionGet).toHaveBeenCalledTimes(1);
  expect(cache.size).toBe(1);
  expect(Object.isFrozen(cache.get('https://pods.example/alice/followers'))).toBe(true);
});

test('caches an empty sender followers collection within the run', async () => {
  const cache = new Map();
  const collectionGet = jest.fn(async () => ({
    id: 'https://pods.example/alice/followers',
    type: 'Collection',
    items: []
  }));
  const ctx = {
    call: jest.fn(async action => {
      if (action === 'activitypub.collection.get') return collectionGet();
      throw new Error(`Unexpected call ${action}`);
    })
  };
  const activity = { actor: 'https://pods.example/alice' };
  const context = expansionContext();

  expect(
    await service.methods.expandConcreteRecipients.call(
      context,
      ctx,
      activity,
      ['https://pods.example/alice/followers'],
      'alice',
      cache
    )
  ).toEqual([]);
  expect(
    await service.methods.expandConcreteRecipients.call(
      context,
      ctx,
      activity,
      ['https://pods.example/alice/followers'],
      'alice',
      cache
    )
  ).toEqual([]);

  expect(collectionGet).toHaveBeenCalledTimes(1);
  expect(context.logger.debug).toHaveBeenCalledTimes(1);
});

test('does not retain another actor followers collection in the sender cache', async () => {
  const cache = new Map();
  const collectionGet = jest.fn(async () => ({
    id: 'https://pods.example/bob/followers',
    type: 'Collection',
    items: ['https://remote.example/users/carol']
  }));
  const ctx = {
    call: jest.fn(async action => {
      if (action === 'activitypub.collection.get') return collectionGet();
      throw new Error(`Unexpected call ${action}`);
    })
  };
  const activity = { actor: 'https://pods.example/alice' };
  const context = expansionContext();

  await service.methods.expandConcreteRecipients.call(
    context,
    ctx,
    activity,
    ['https://pods.example/bob/followers'],
    'alice',
    cache
  );
  await service.methods.expandConcreteRecipients.call(
    context,
    ctx,
    activity,
    ['https://pods.example/bob/followers'],
    'alice',
    cache
  );

  expect(collectionGet).toHaveBeenCalledTimes(2);
  expect(cache.size).toBe(0);
});

test('reconcileAccount shares one sender followers cache across activities but not across runs', async () => {
  const now = new Date().toISOString();
  const rows = ['a', 'b'].map(suffix => ({
    activityUri: { value: `https://pods.example/alice/activities/${suffix}` },
    published: { value: now }
  }));
  const seenCaches = [];
  const context = {
    settings: { lookbackMs: 900000, maxActivitiesPerAccount: 50 },
    logger: { warn: jest.fn() },
    listOutboxActivityPage: jest.fn(async () => ({ rows, nextCursor: null })),
    reconcileActivity: jest.fn(async (_ctx, _activity, _dataset, cache) => {
      seenCaches.push(cache);
      return null;
    })
  };
  const ctx = {
    call: jest.fn(async (action, params) => {
      if (action === 'activitypub.actor.getCollectionUri') return 'https://pods.example/alice/outbox';
      if (action === 'activitypub.activity.get') {
        return {
          id: params.resourceUri,
          actor: 'https://pods.example/alice',
          type: 'Create',
          published: now
        };
      }
      throw new Error(`Unexpected call ${action}`);
    })
  };
  const account = { webId: 'https://pods.example/alice', username: 'alice' };

  await service.methods.reconcileAccount.call(context, ctx, account);
  await service.methods.reconcileAccount.call(context, ctx, account);

  expect(seenCaches).toHaveLength(4);
  expect(seenCaches[0]).toBeInstanceOf(Map);
  expect(seenCaches[0]).toBe(seenCaches[1]);
  expect(seenCaches[2]).toBe(seenCaches[3]);
  expect(seenCaches[0]).not.toBe(seenCaches[2]);
});
