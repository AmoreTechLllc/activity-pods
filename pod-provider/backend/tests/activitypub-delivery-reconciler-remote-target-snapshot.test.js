'use strict';

process.env.SEMAPPS_AVAILABLE_LOCALES ||= 'en';
process.env.SEMAPPS_AUTH_RESERVED_USER_NAMES ||= 'admin';

const service = require('../services/activitypub-delivery-reconciler.service');
const { buildDeliveryPlanV1 } = require('../utils/activitypub-delivery-planner');

const LOCAL_ACTOR = 'https://pods.example/alice';
const REMOTE_ACTOR = 'https://remote.example/users/bob';

function activity(id) {
  return {
    id,
    type: 'Create',
    actor: LOCAL_ACTOR,
    published: new Date().toISOString(),
    to: [REMOTE_ACTOR],
    cc: [],
    object: {
      id: `${id}/object`,
      type: 'Note',
      attributedTo: LOCAL_ACTOR,
      content: 'snapshot test'
    }
  };
}

test('planner reuses one validated remote target across activities when an explicit scan snapshot is supplied', async () => {
  const remoteDeliveryTargets = new Map();
  const actorGet = jest.fn(async (_action, params) => ({
    id: params.actorUri,
    inbox: `${params.actorUri}/inbox`,
    endpoints: { sharedInbox: 'https://remote.example/inbox' }
  }));
  const ctx = {
    call: jest.fn(async (action, params) => {
      if (action === 'activitypub.actor.get') return actorGet(action, params);
      throw new Error(`Unexpected call ${action}`);
    })
  };

  const first = await buildDeliveryPlanV1(ctx, {
    activity: activity(`${LOCAL_ACTOR}/activities/one`),
    remoteRecipientUris: [REMOTE_ACTOR],
    remoteDeliveryTargets
  });
  const second = await buildDeliveryPlanV1(ctx, {
    activity: activity(`${LOCAL_ACTOR}/activities/two`),
    remoteRecipientUris: [REMOTE_ACTOR],
    remoteDeliveryTargets
  });

  expect(actorGet).toHaveBeenCalledTimes(1);
  expect(remoteDeliveryTargets.size).toBe(1);
  expect(Object.isFrozen(remoteDeliveryTargets.get(REMOTE_ACTOR))).toBe(true);
  expect(first.remoteRecipients).toEqual(second.remoteRecipients);
});

test('planner does not cache a failed remote target resolution and can recover on the next activity', async () => {
  const remoteDeliveryTargets = new Map();
  let attempts = 0;
  const ctx = {
    call: jest.fn(async action => {
      if (action !== 'activitypub.actor.get') throw new Error(`Unexpected call ${action}`);
      attempts += 1;
      if (attempts === 1) return { id: REMOTE_ACTOR };
      return {
        id: REMOTE_ACTOR,
        inbox: `${REMOTE_ACTOR}/inbox`,
        endpoints: { sharedInbox: 'https://remote.example/inbox' }
      };
    })
  };

  await expect(
    buildDeliveryPlanV1(ctx, {
      activity: activity(`${LOCAL_ACTOR}/activities/fail-first`),
      remoteRecipientUris: [REMOTE_ACTOR],
      remoteDeliveryTargets
    })
  ).rejects.toThrow(/Unable to resolve remote inbox/u);
  expect(remoteDeliveryTargets.size).toBe(0);

  await expect(
    buildDeliveryPlanV1(ctx, {
      activity: activity(`${LOCAL_ACTOR}/activities/recover`),
      remoteRecipientUris: [REMOTE_ACTOR],
      remoteDeliveryTargets
    })
  ).resolves.toEqual(expect.objectContaining({ activityId: `${LOCAL_ACTOR}/activities/recover` }));
  expect(attempts).toBe(2);
  expect(remoteDeliveryTargets.size).toBe(1);
});

test.each([
  [{ actorUri: 'https://remote.example/users/mallory', inboxUrl: `${REMOTE_ACTOR}/inbox` }, /does not match/u],
  [{ actorUri: REMOTE_ACTOR, inboxUrl: 'javascript:alert(1)' }, /invalid remote inbox/u],
  [{ actorUri: REMOTE_ACTOR, inboxUrl: `${REMOTE_ACTOR}/inbox`, sharedInboxUrl: 'ftp://remote.example/inbox' }, /invalid remote shared inbox/u]
])('planner fails closed on poisoned cached remote target %#', async (cached, pattern) => {
  const remoteDeliveryTargets = new Map([[REMOTE_ACTOR, cached]]);
  const ctx = { call: jest.fn() };

  await expect(
    buildDeliveryPlanV1(ctx, {
      activity: activity(`${LOCAL_ACTOR}/activities/poisoned`),
      remoteRecipientUris: [REMOTE_ACTOR],
      remoteDeliveryTargets
    })
  ).rejects.toThrow(pattern);

  expect(ctx.call).not.toHaveBeenCalled();
});

test('reconcileAccount shares one remote-target snapshot across activities but not across account scans', async () => {
  const now = new Date().toISOString();
  const rows = ['one', 'two'].map(suffix => ({
    activityUri: { value: `${LOCAL_ACTOR}/activities/${suffix}` },
    published: { value: now }
  }));
  const seenSnapshots = [];
  const context = {
    settings: { lookbackMs: 900000, maxActivitiesPerAccount: 50 },
    logger: { warn: jest.fn() },
    resolveLocalOutboxUri: service.methods.resolveLocalOutboxUri,
    listOutboxActivityPage: jest.fn(async () => ({ rows, nextCursor: null })),
    reconcileActivity: jest.fn(async (_ctx, _activity, _dataset, _followersSnapshot, remoteTargetSnapshot) => {
      seenSnapshots.push(remoteTargetSnapshot);
      return null;
    })
  };
  const ctx = {
    call: jest.fn(async (action, params) => {
      if (action === 'triplestore.query') {
        expect(params.dataset).toBe('alice');
        expect(params.webId).toBe('system');
        return [{ outboxUri: { value: `${LOCAL_ACTOR}/outbox` } }];
      }
      if (action === 'activitypub.activity.get') {
        return {
          id: params.resourceUri,
          type: 'Create',
          actor: LOCAL_ACTOR,
          published: now
        };
      }
      throw new Error(`Unexpected call ${action}`);
    })
  };
  const account = { webId: LOCAL_ACTOR, username: 'alice' };

  await service.methods.reconcileAccount.call(context, ctx, account);
  await service.methods.reconcileAccount.call(context, ctx, account);

  expect(seenSnapshots).toHaveLength(4);
  expect(seenSnapshots[0]).toBeInstanceOf(Map);
  expect(seenSnapshots[0]).toBe(seenSnapshots[1]);
  expect(seenSnapshots[2]).toBe(seenSnapshots[3]);
  expect(seenSnapshots[0]).not.toBe(seenSnapshots[2]);
});
