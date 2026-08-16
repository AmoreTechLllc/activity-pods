'use strict';

process.env.SEMAPPS_AVAILABLE_LOCALES ||= 'en';
process.env.SEMAPPS_AUTH_RESERVED_USER_NAMES ||= 'admin';

const service = require('../services/activitypub-delivery-reconciler.service');
const {
  buildDeliveryPlanV1,
  resolveLocalDeliveryTargetWithCache
} = require('../utils/activitypub-delivery-planner');

const SENDER = 'https://pods.example/alice';
const LOCAL_RECIPIENT = 'https://pods.example/bob';

function localActivity(id) {
  return {
    id,
    type: 'Create',
    actor: SENDER,
    published: new Date().toISOString(),
    to: [LOCAL_RECIPIENT],
    cc: [],
    object: {
      id: `${id}/object`,
      type: 'Note',
      attributedTo: SENDER,
      content: 'local snapshot test'
    }
  };
}

function localAccount(username = 'bob') {
  return { '@id': `urn:account:${username}`, webId: LOCAL_RECIPIENT, username };
}

test('planner reuses one validated local inbox across activities when the fresh account dataset is unchanged', async () => {
  const localDeliveryTargets = new Map();
  const localRecipientAccounts = new Map([[LOCAL_RECIPIENT, localAccount()]]);
  const inboxQueries = [];
  const ctx = {
    call: jest.fn(async (action, params) => {
      if (action !== 'triplestore.query') throw new Error(`Unexpected call ${action}`);
      inboxQueries.push(params);
      expect(params.dataset).toBe('bob');
      expect(params.webId).toBe('system');
      return [{ inboxUri: { value: `${LOCAL_RECIPIENT}/inbox` } }];
    })
  };

  const first = await buildDeliveryPlanV1(ctx, {
    activity: localActivity(`${SENDER}/activities/one`),
    localRecipientUris: [LOCAL_RECIPIENT],
    localRecipientAccounts,
    localDeliveryTargets
  });
  const second = await buildDeliveryPlanV1(ctx, {
    activity: localActivity(`${SENDER}/activities/two`),
    localRecipientUris: [LOCAL_RECIPIENT],
    localRecipientAccounts,
    localDeliveryTargets
  });

  expect(inboxQueries).toHaveLength(1);
  expect(localDeliveryTargets.size).toBe(1);
  expect(Object.isFrozen(localDeliveryTargets.get(LOCAL_RECIPIENT))).toBe(true);
  expect(first.localRecipients).toEqual(second.localRecipients);
});

test('fresh account dataset change invalidates a cached local inbox and rereads the new pod dataset', async () => {
  const localDeliveryTargets = new Map();
  const seenDatasets = [];
  const ctx = {
    call: jest.fn(async (action, params) => {
      if (action !== 'triplestore.query') throw new Error(`Unexpected call ${action}`);
      seenDatasets.push(params.dataset);
      return [{ inboxUri: { value: `https://pods.example/${params.dataset}/inbox` } }];
    })
  };

  await resolveLocalDeliveryTargetWithCache(
    ctx,
    LOCAL_RECIPIENT,
    true,
    localAccount('bob'),
    localDeliveryTargets
  );
  const moved = await resolveLocalDeliveryTargetWithCache(
    ctx,
    LOCAL_RECIPIENT,
    true,
    localAccount('bob-new'),
    localDeliveryTargets
  );

  expect(seenDatasets).toEqual(['bob', 'bob-new']);
  expect(moved).toEqual({
    actorUri: LOCAL_RECIPIENT,
    dataset: 'bob-new',
    inboxUri: 'https://pods.example/bob-new/inbox'
  });
  expect(localDeliveryTargets.get(LOCAL_RECIPIENT)).toEqual(moved);
});

test.each([
  { actorUri: 'https://pods.example/mallory', dataset: 'bob', inboxUri: `${LOCAL_RECIPIENT}/inbox` },
  { actorUri: LOCAL_RECIPIENT, dataset: 'wrong', inboxUri: `${LOCAL_RECIPIENT}/inbox` },
  { actorUri: LOCAL_RECIPIENT, dataset: 'bob', inboxUri: 'javascript:alert(1)' }
])('invalid cached local target %# is evicted and refreshed from the authoritative dataset', async cached => {
  const localDeliveryTargets = new Map([[LOCAL_RECIPIENT, cached]]);
  const ctx = {
    call: jest.fn(async (action, params) => {
      if (action !== 'triplestore.query') throw new Error(`Unexpected call ${action}`);
      expect(params.dataset).toBe('bob');
      return [{ inboxUri: { value: `${LOCAL_RECIPIENT}/inbox` } }];
    })
  };

  const target = await resolveLocalDeliveryTargetWithCache(
    ctx,
    LOCAL_RECIPIENT,
    true,
    localAccount(),
    localDeliveryTargets
  );

  expect(ctx.call).toHaveBeenCalledTimes(1);
  expect(target).toEqual({ actorUri: LOCAL_RECIPIENT, dataset: 'bob', inboxUri: `${LOCAL_RECIPIENT}/inbox` });
  expect(localDeliveryTargets.get(LOCAL_RECIPIENT)).toEqual(target);
  expect(Object.isFrozen(localDeliveryTargets.get(LOCAL_RECIPIENT))).toBe(true);
});

test('local target snapshot stops retaining new actors at its configured bound', async () => {
  const firstActor = 'https://pods.example/bob';
  const secondActor = 'https://pods.example/carol';
  const localDeliveryTargets = new Map();
  const ctx = {
    call: jest.fn(async (action, params) => {
      if (action !== 'triplestore.query') throw new Error(`Unexpected call ${action}`);
      const actor = params.query.includes('<https://pods.example/bob>') ? firstActor : secondActor;
      return [{ inboxUri: { value: `${actor}/inbox` } }];
    })
  };

  await resolveLocalDeliveryTargetWithCache(ctx, firstActor, true, { webId: firstActor, username: 'bob' }, localDeliveryTargets, 1);
  await resolveLocalDeliveryTargetWithCache(ctx, secondActor, true, { webId: secondActor, username: 'carol' }, localDeliveryTargets, 1);

  expect(localDeliveryTargets.size).toBe(1);
  expect(localDeliveryTargets.has(firstActor)).toBe(true);
  expect(localDeliveryTargets.has(secondActor)).toBe(false);
  expect(ctx.call).toHaveBeenCalledTimes(2);
});

test('reconcileAccount shares one local-target snapshot across activities but not across account scans', async () => {
  const now = new Date().toISOString();
  const rows = ['one', 'two'].map(suffix => ({
    activityUri: { value: `${SENDER}/activities/${suffix}` },
    published: { value: now }
  }));
  const seenLocalSnapshots = [];
  const context = {
    settings: { lookbackMs: 900000, maxActivitiesPerAccount: 50 },
    logger: { warn: jest.fn() },
    resolveLocalOutboxUri: service.methods.resolveLocalOutboxUri,
    listOutboxActivityPage: jest.fn(async () => ({ rows, nextCursor: null })),
    reconcileActivity: jest.fn(async (_ctx, _activity, _dataset, _followers, _remoteTargets, localTargets) => {
      seenLocalSnapshots.push(localTargets);
      return null;
    })
  };
  const ctx = {
    call: jest.fn(async (action, params) => {
      if (action === 'triplestore.query') {
        expect(params.dataset).toBe('alice');
        return [{ outboxUri: { value: `${SENDER}/outbox` } }];
      }
      if (action === 'activitypub.activity.get') {
        return { id: params.resourceUri, type: 'Create', actor: SENDER, published: now };
      }
      throw new Error(`Unexpected call ${action}`);
    })
  };
  const account = { webId: SENDER, username: 'alice' };

  await service.methods.reconcileAccount.call(context, ctx, account);
  await service.methods.reconcileAccount.call(context, ctx, account);

  expect(seenLocalSnapshots).toHaveLength(4);
  expect(seenLocalSnapshots[0]).toBeInstanceOf(Map);
  expect(seenLocalSnapshots[0]).toBe(seenLocalSnapshots[1]);
  expect(seenLocalSnapshots[2]).toBe(seenLocalSnapshots[3]);
  expect(seenLocalSnapshots[0]).not.toBe(seenLocalSnapshots[2]);
});
