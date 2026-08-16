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

function snapshot(actorUri = 'https://pods.example/alice') {
  return { actorUri, items: null };
}

test('reuses the account-bound sender followers expansion within one reconciliation run', async () => {
  const followersSnapshot = snapshot();
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

  const first = await service.methods.expandConcreteRecipients.call(
    context,
    ctx,
    activity,
    recipients,
    'alice',
    followersSnapshot
  );
  const second = await service.methods.expandConcreteRecipients.call(
    context,
    ctx,
    activity,
    recipients,
    'alice',
    followersSnapshot
  );

  expect(first).toEqual(['https://remote.example/users/bob', 'https://remote.example/users/carol']);
  expect(second).toEqual(first);
  expect(collectionGet).toHaveBeenCalledTimes(1);
  expect(followersSnapshot.actorUri).toBe('https://pods.example/alice');
  expect(Object.isFrozen(followersSnapshot.items)).toBe(true);
});

test('caches an empty sender followers collection within the run', async () => {
  const followersSnapshot = snapshot();
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
      followersSnapshot
    )
  ).toEqual([]);
  expect(
    await service.methods.expandConcreteRecipients.call(
      context,
      ctx,
      activity,
      ['https://pods.example/alice/followers'],
      'alice',
      followersSnapshot
    )
  ).toEqual([]);

  expect(collectionGet).toHaveBeenCalledTimes(1);
  expect(context.logger.debug).toHaveBeenCalledTimes(1);
  expect(followersSnapshot.items).toEqual([]);
});

test('does not retain another actor followers collection in the account-bound snapshot', async () => {
  const followersSnapshot = snapshot();
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
    followersSnapshot
  );
  await service.methods.expandConcreteRecipients.call(
    context,
    ctx,
    activity,
    ['https://pods.example/bob/followers'],
    'alice',
    followersSnapshot
  );

  expect(collectionGet).toHaveBeenCalledTimes(2);
  expect(followersSnapshot.items).toBeNull();
});

test('a mismatched persisted activity actor cannot populate the account follower snapshot', async () => {
  const followersSnapshot = snapshot('https://pods.example/alice');
  const collectionGet = jest.fn(async () => ({
    id: 'https://pods.example/mallory/followers',
    type: 'Collection',
    items: ['https://remote.example/users/carol']
  }));
  const ctx = {
    call: jest.fn(async action => {
      if (action === 'activitypub.collection.get') return collectionGet();
      throw new Error(`Unexpected call ${action}`);
    })
  };
  const activity = { actor: 'https://pods.example/mallory' };
  const context = expansionContext();

  await service.methods.expandConcreteRecipients.call(
    context,
    ctx,
    activity,
    ['https://pods.example/mallory/followers'],
    'alice',
    followersSnapshot
  );
  await service.methods.expandConcreteRecipients.call(
    context,
    ctx,
    activity,
    ['https://pods.example/mallory/followers'],
    'alice',
    followersSnapshot
  );

  expect(collectionGet).toHaveBeenCalledTimes(2);
  expect(followersSnapshot).toEqual({ actorUri: 'https://pods.example/alice', items: null });
});

test('reconcileAccount shares one account-bound follower snapshot across activities but not across runs', async () => {
  const now = new Date().toISOString();
  const rows = ['a', 'b'].map(suffix => ({
    activityUri: { value: `https://pods.example/alice/activities/${suffix}` },
    published: { value: now }
  }));
  const seenSnapshots = [];
  const context = {
    settings: { lookbackMs: 900000, maxActivitiesPerAccount: 50 },
    logger: { warn: jest.fn() },
    resolveLocalOutboxUri: service.methods.resolveLocalOutboxUri,
    listOutboxActivityPage: jest.fn(async () => ({ rows, nextCursor: null })),
    reconcileActivity: jest.fn(async (_ctx, _activity, _dataset, followersSnapshot) => {
      seenSnapshots.push(followersSnapshot);
      return null;
    })
  };
  const ctx = {
    call: jest.fn(async (action, params) => {
      if (action === 'activitypub.actor.getCollectionUri') {
        throw new Error('heavy actor materialization path must not be used by reconciliation');
      }
      if (action === 'triplestore.query') {
        expect(params.dataset).toBe('alice');
        expect(params.webId).toBe('system');
        expect(params.query).toContain('<https://pods.example/alice> as:outbox ?outboxUri');
        return [{ outboxUri: { value: 'https://pods.example/alice/outbox' } }];
      }
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

  expect(seenSnapshots).toHaveLength(4);
  expect(seenSnapshots[0]).toBe(seenSnapshots[1]);
  expect(seenSnapshots[2]).toBe(seenSnapshots[3]);
  expect(seenSnapshots[0]).not.toBe(seenSnapshots[2]);
  expect(seenSnapshots[0]).toEqual({ actorUri: 'https://pods.example/alice', items: null });
  expect(seenSnapshots[2]).toEqual({ actorUri: 'https://pods.example/alice', items: null });
});
