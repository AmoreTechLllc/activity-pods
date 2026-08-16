'use strict';

process.env.SEMAPPS_AVAILABLE_LOCALES ||= 'en';
process.env.SEMAPPS_AUTH_RESERVED_USER_NAMES ||= 'admin';

const service = require('../services/activitypub-delivery-reconciler.service');

const ALICE = 'https://pods.example/alice';
const ALICE_FOLLOWERS = `${ALICE}/followers`;

function expansionContext() {
  return {
    settings: { baseUri: 'https://pods.example' },
    logger: { debug: jest.fn(), warn: jest.fn() },
    listSenderFollowerUris: service.methods.listSenderFollowerUris
  };
}

function snapshot(actorUri = ALICE) {
  return { actorUri, items: null };
}

function followerRows(...uris) {
  return uris.length > 0 ? uris.map(uri => ({ itemUri: { value: uri } })) : [{}];
}

test('selectively reads sender follower membership once and reuses it within one reconciliation run', async () => {
  const followersSnapshot = snapshot();
  const query = jest.fn(async params => {
    expect(params.dataset).toBe('alice');
    expect(params.webId).toBe(ALICE);
    expect(params.accept).toBe('application/sparql-results+json');
    expect(params.query).toContain('PREFIX as: <https://www.w3.org/ns/activitystreams#>');
    expect(params.query).toContain(`<${ALICE_FOLLOWERS}> a as:Collection`);
    expect(params.query).toContain(`<${ALICE_FOLLOWERS}> as:items ?itemUri`);
    expect(params.query).toMatch(/SELECT DISTINCT \?itemUri/u);
    expect(params.query).not.toContain('LIMIT');
    return followerRows('https://remote.example/users/bob', 'https://remote.example/users/carol');
  });
  const ctx = {
    call: jest.fn(async (action, params) => {
      if (action === 'triplestore.query') return query(params);
      if (action === 'activitypub.collection.get') {
        throw new Error('sender followers must not use full collection materialization');
      }
      throw new Error(`Unexpected call ${action}`);
    })
  };
  const activity = { actor: ALICE };
  const recipients = [`${ALICE_FOLLOWERS}/`];
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
  expect(query).toHaveBeenCalledTimes(1);
  expect(ctx.call.mock.calls.some(([action]) => action === 'activitypub.collection.get')).toBe(false);
  expect(followersSnapshot.actorUri).toBe(ALICE);
  expect(Object.isFrozen(followersSnapshot.items)).toBe(true);
});

test('caches an authoritative empty sender followers collection within the run', async () => {
  const followersSnapshot = snapshot();
  const query = jest.fn(async () => followerRows());
  const ctx = {
    call: jest.fn(async (action, params) => {
      if (action === 'triplestore.query') return query(params);
      if (action === 'activitypub.collection.get') {
        throw new Error('sender followers must not use full collection materialization');
      }
      throw new Error(`Unexpected call ${action}`);
    })
  };
  const activity = { actor: ALICE };
  const context = expansionContext();

  expect(
    await service.methods.expandConcreteRecipients.call(
      context,
      ctx,
      activity,
      [ALICE_FOLLOWERS],
      'alice',
      followersSnapshot
    )
  ).toEqual([]);
  expect(
    await service.methods.expandConcreteRecipients.call(
      context,
      ctx,
      activity,
      [ALICE_FOLLOWERS],
      'alice',
      followersSnapshot
    )
  ).toEqual([]);

  expect(query).toHaveBeenCalledTimes(1);
  expect(context.logger.debug).toHaveBeenCalledTimes(1);
  expect(followersSnapshot.items).toEqual([]);
});

test('selective sender follower lookup rejects a missing collection instead of silently treating it as empty', async () => {
  const ctx = { call: jest.fn(async () => []) };

  await expect(service.methods.listSenderFollowerUris(ctx, ALICE, 'alice')).rejects.toThrow(
    /Unable to resolve sender followers collection/u
  );
});

test('selective sender follower lookup deduplicates duplicate bindings from the authoritative store', async () => {
  const bob = 'https://remote.example/users/bob';
  const ctx = { call: jest.fn(async () => followerRows(bob, bob)) };

  await expect(service.methods.listSenderFollowerUris(ctx, ALICE, 'alice')).resolves.toEqual([bob]);
});

test.each([
  [null],
  [''],
  ['https://pods.example/alice> ?s ?p ?o . #']
])('selective sender follower lookup rejects invalid or injected actor URI %p before Fuseki', async actorUri => {
  const call = jest.fn();

  await expect(service.methods.listSenderFollowerUris({ call }, actorUri, 'alice')).rejects.toThrow();
  expect(call).not.toHaveBeenCalled();
});

test.each([
  [null],
  ['']
])('selective sender follower lookup rejects invalid dataset %p before Fuseki', async dataset => {
  const call = jest.fn();

  await expect(service.methods.listSenderFollowerUris({ call }, ALICE, dataset)).rejects.toThrow(/requires a dataset/u);
  expect(call).not.toHaveBeenCalled();
});

test.each([
  [null],
  [42],
  [{ itemUri: null }],
  [{ itemUri: {} }],
  [{ itemUri: { value: '' } }]
])('selective sender follower lookup fails closed on malformed result row %p', async malformedRow => {
  const ctx = { call: jest.fn(async () => [malformedRow]) };

  await expect(service.methods.listSenderFollowerUris(ctx, ALICE, 'alice')).rejects.toThrow(/Malformed sender/u);
});

test('does not use the sender dataset shortcut for another actor followers collection', async () => {
  const followersSnapshot = snapshot();
  const collectionGet = jest.fn(async () => ({
    id: 'https://pods.example/bob/followers',
    type: 'Collection',
    items: ['https://remote.example/users/carol']
  }));
  const ctx = {
    call: jest.fn(async action => {
      if (action === 'activitypub.collection.get') return collectionGet();
      if (action === 'triplestore.query') throw new Error('another actor must keep cross-dataset-aware collection resolution');
      throw new Error(`Unexpected call ${action}`);
    })
  };
  const activity = { actor: ALICE };
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
  const followersSnapshot = snapshot(ALICE);
  const collectionGet = jest.fn(async () => ({
    id: 'https://pods.example/mallory/followers',
    type: 'Collection',
    items: ['https://remote.example/users/carol']
  }));
  const ctx = {
    call: jest.fn(async action => {
      if (action === 'activitypub.collection.get') return collectionGet();
      if (action === 'triplestore.query') throw new Error('mismatched actor must not use account-bound sender shortcut');
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
  expect(followersSnapshot).toEqual({ actorUri: ALICE, items: null });
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
          actor: ALICE,
          type: 'Create',
          published: now
        };
      }
      throw new Error(`Unexpected call ${action}`);
    })
  };
  const account = { webId: ALICE, username: 'alice' };

  await service.methods.reconcileAccount.call(context, ctx, account);
  await service.methods.reconcileAccount.call(context, ctx, account);

  expect(seenSnapshots).toHaveLength(4);
  expect(seenSnapshots[0]).toBe(seenSnapshots[1]);
  expect(seenSnapshots[2]).toBe(seenSnapshots[3]);
  expect(seenSnapshots[0]).not.toBe(seenSnapshots[2]);
  expect(seenSnapshots[0]).toEqual({ actorUri: ALICE, items: null });
  expect(seenSnapshots[2]).toEqual({ actorUri: ALICE, items: null });
});