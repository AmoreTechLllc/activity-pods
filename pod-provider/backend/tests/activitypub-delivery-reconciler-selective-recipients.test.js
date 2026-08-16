'use strict';

process.env.SEMAPPS_AVAILABLE_LOCALES ||= 'en';
process.env.SEMAPPS_AUTH_RESERVED_USER_NAMES ||= 'admin';

const service = require('../services/activitypub-delivery-reconciler.service');
const { resolveLocalFollowersUri } = require('../utils/activitypub-delivery-planner');

const SENDER = 'https://pods.example/alice';
const FOLLOWERS = `${SENDER}/followers`;
const REMOTE = 'https://remote.example/users/bob';
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

function methodContext() {
  return {
    settings: { baseUri: 'https://pods.example' },
    logger: { debug: jest.fn(), warn: jest.fn() },
    listSenderFollowerUris: service.methods.listSenderFollowerUris
  };
}

test('selective followers URI lookup reads only the authoritative actor predicate', async () => {
  const call = jest.fn(async (action, params) => {
    expect(action).toBe('triplestore.query');
    expect(params.dataset).toBe('alice');
    expect(params.webId).toBe('system');
    expect(params.accept).toBe('application/sparql-results+json');
    expect(params.query).toContain('PREFIX as: <https://www.w3.org/ns/activitystreams#>');
    expect(params.query).toContain(`<${SENDER}> as:followers ?followersUri`);
    expect(params.query).toMatch(/SELECT DISTINCT \?followersUri/u);
    expect(params.query).toMatch(/LIMIT 2/u);
    return [{ followersUri: { value: FOLLOWERS } }];
  });

  await expect(resolveLocalFollowersUri({ call }, SENDER, 'alice')).resolves.toBe(FOLLOWERS);
  expect(call).toHaveBeenCalledTimes(1);
});

test('selective recipient resolution preserves SemApps addressing semantics and snapshots sender followers', async () => {
  const snapshot = { actorUri: SENDER, items: null };
  let followersPropertyQueries = 0;
  let membershipQueries = 0;
  const ctx = {
    call: jest.fn(async (action, params) => {
      if (action !== 'triplestore.query') throw new Error(`Legacy recipient path must not run: ${action}`);
      if (params.query.includes('as:followers ?followersUri')) {
        followersPropertyQueries += 1;
        return [{ followersUri: { value: FOLLOWERS } }];
      }
      if (params.query.includes(`${FOLLOWERS}> as:items ?itemUri`)) {
        membershipQueries += 1;
        return [{ itemUri: { value: REMOTE } }];
      }
      throw new Error(`Unexpected query ${params.query}`);
    })
  };
  const activity = {
    actor: SENDER,
    to: PUBLIC,
    bto: 'https://remote.example/users/private',
    cc: [FOLLOWERS, 'Public', 'as:Public'],
    bcc: REMOTE
  };
  const context = methodContext();

  const first = await service.methods.resolveReconciliationRecipients.call(context, ctx, activity, 'alice', snapshot);
  const second = await service.methods.resolveReconciliationRecipients.call(context, ctx, activity, 'alice', snapshot);

  expect(first).toEqual(['https://remote.example/users/private', REMOTE]);
  expect(second).toEqual(first);
  expect(followersPropertyQueries).toBe(1);
  expect(membershipQueries).toBe(1);
  expect(snapshot.followersUri).toBe(FOLLOWERS);
  expect(snapshot.items).toEqual([REMOTE]);
  expect(Object.isFrozen(snapshot.items)).toBe(true);
});

test('selective recipient resolution skips a remote sender-followers property exactly as SemApps does', async () => {
  const remoteFollowers = 'https://remote.example/users/alice/followers';
  const snapshot = { actorUri: SENDER, items: null };
  const ctx = {
    call: jest.fn(async (action, params) => {
      expect(action).toBe('triplestore.query');
      expect(params.query).toContain('as:followers ?followersUri');
      return [{ followersUri: { value: remoteFollowers } }];
    })
  };

  const result = await service.methods.resolveReconciliationRecipients.call(
    methodContext(),
    ctx,
    { actor: SENDER, to: remoteFollowers, cc: REMOTE },
    'alice',
    snapshot
  );

  expect(result).toEqual([REMOTE]);
  expect(ctx.call).toHaveBeenCalledTimes(1);
  expect(snapshot.items).toBeNull();
});

test('missing selective followers authority falls back to the SemApps recipient action', async () => {
  const snapshot = { actorUri: SENDER, items: null };
  const legacyRecipients = [REMOTE];
  const ctx = {
    call: jest.fn(async (action, params) => {
      if (action === 'triplestore.query') return [];
      if (action === 'activitypub.activity.getRecipients') {
        expect(params.activity.actor).toBe(SENDER);
        return legacyRecipients;
      }
      throw new Error(`Unexpected call ${action}`);
    })
  };

  await expect(
    service.methods.resolveReconciliationRecipients.call(
      methodContext(),
      ctx,
      { actor: SENDER, to: REMOTE },
      'alice',
      snapshot
    )
  ).resolves.toBe(legacyRecipients);

  expect(ctx.call.mock.calls.map(([action]) => action)).toEqual([
    'triplestore.query',
    'activitypub.activity.getRecipients'
  ]);
});

test('mismatched persisted actor retains the legacy recipient authority path', async () => {
  const snapshot = { actorUri: SENDER, items: null };
  const mallory = 'https://pods.example/mallory';
  const ctx = {
    call: jest.fn(async action => {
      if (action === 'activitypub.activity.getRecipients') return [REMOTE];
      throw new Error(`Unexpected call ${action}`);
    })
  };

  await expect(
    service.methods.resolveReconciliationRecipients.call(
      methodContext(),
      ctx,
      { actor: mallory, to: REMOTE },
      'alice',
      snapshot
    )
  ).resolves.toEqual([REMOTE]);
  expect(ctx.call).toHaveBeenCalledTimes(1);
});

test('two follower-addressed activities use one selective sender property read and one membership read', async () => {
  const published = new Date().toISOString();
  const activities = ['one', 'two'].map(suffix => ({
    id: `${SENDER}/activities/${suffix}`,
    type: 'Create',
    actor: SENDER,
    published,
    to: [PUBLIC],
    cc: [FOLLOWERS],
    object: {
      id: `${SENDER}/objects/${suffix}`,
      type: 'Note',
      attributedTo: SENDER,
      content: suffix
    }
  }));
  let followersPropertyQueries = 0;
  let membershipQueries = 0;
  let remoteActorGets = 0;
  const enqueued = [];
  const context = {
    settings: {
      baseUri: 'https://pods.example',
      accountsDataset: 'settings',
      lookbackMs: 900000,
      maxActivitiesPerAccount: 50
    },
    logger: { debug: jest.fn(), warn: jest.fn() },
    resolveLocalOutboxUri: service.methods.resolveLocalOutboxUri,
    listOutboxActivityPage: jest.fn(async () => ({
      rows: activities.map(item => ({ activityUri: { value: item.id }, published: { value: item.published } })),
      nextCursor: null
    })),
    resolveReconciliationRecipients: service.methods.resolveReconciliationRecipients,
    listSenderFollowerUris: service.methods.listSenderFollowerUris,
    reconcileActivity: service.methods.reconcileActivity,
    expandConcreteRecipients: service.methods.expandConcreteRecipients,
    findLocalAccountsByWebIds: service.methods.findLocalAccountsByWebIds,
    loadBlindRecipientSnapshot: jest.fn(async () => null)
  };
  const ctx = {
    call: jest.fn(async (action, params, options) => {
      if (action === 'triplestore.query') {
        if (params.query.includes('as:outbox ?outboxUri')) {
          return [{ outboxUri: { value: `${SENDER}/outbox` } }];
        }
        if (params.query.includes('as:followers ?followersUri')) {
          followersPropertyQueries += 1;
          expect(params.dataset).toBe('alice');
          return [{ followersUri: { value: FOLLOWERS } }];
        }
        if (params.query.includes(`${FOLLOWERS}> as:items ?itemUri`)) {
          membershipQueries += 1;
          expect(params.dataset).toBe('alice');
          expect(params.webId).toBe(SENDER);
          return [{ itemUri: { value: REMOTE } }];
        }
        throw new Error(`Unexpected triplestore query ${params.query}`);
      }
      if (action === 'activitypub.activity.get') {
        expect(options).toEqual({ meta: { dataset: 'alice' } });
        return activities.find(item => item.id === params.resourceUri);
      }
      if (action === 'activitypub.activity.getRecipients') {
        throw new Error('legacy recipient action must not run on the normal reconciliation path');
      }
      if (action === 'activitypub.collection.get') {
        throw new Error('full collection materialization must not run for sender followers');
      }
      if (action === 'activitypub.actor.get') {
        if (params.actorUri === SENDER) {
          throw new Error('sender actor materialization must not run during recipient resolution');
        }
        remoteActorGets += 1;
        return {
          id: params.actorUri,
          inbox: `${params.actorUri}/inbox`,
          endpoints: { sharedInbox: 'https://remote.example/inbox' }
        };
      }
      if (action === 'activitypub.outbox.enqueueDeliveryHandoff') {
        enqueued.push(params.deliveryPlan);
        return { intentId: params.deliveryPlan.intentId };
      }
      throw new Error(`Unexpected call ${action}`);
    })
  };

  const result = await service.methods.reconcileAccount.call(
    context,
    ctx,
    { webId: SENDER, username: 'alice' }
  );

  expect(result).toEqual({ activitiesScanned: 2, handoffsRequeued: 2, failures: 0 });
  expect(followersPropertyQueries).toBe(1);
  expect(membershipQueries).toBe(1);
  expect(remoteActorGets).toBe(1);
  expect(enqueued).toHaveLength(2);
});
