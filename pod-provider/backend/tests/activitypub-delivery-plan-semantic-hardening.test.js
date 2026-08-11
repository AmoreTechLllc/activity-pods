'use strict';

const {
  buildDeliveryPlanV1,
  createDeliveryIntentId,
  determineVisibility
} = require('../utils/activitypub-delivery-planner');
const { validateDeliveryPlanV1 } = require('../utils/activitypub-delivery-plan');

const ACTOR = 'https://pods.example/alice';

function activity(overrides = {}) {
  return {
    id: 'https://pods.example/alice/activities/hardening',
    type: 'Create',
    actor: ACTOR,
    to: [{ id: `${ACTOR}/followers` }],
    cc: [],
    object: {
      id: 'https://pods.example/alice/objects/hardening',
      type: 'Note',
      attributedTo: ACTOR,
      content: 'hardening'
    },
    ...overrides
  };
}

describe('APDM Phase 3 semantic hardening', () => {
  test('visibility normalization accepts object-valued ActivityPub addressing', () => {
    expect(determineVisibility(activity())).toBe('followers');
    expect(determineVisibility(activity({
      to: [{ id: 'https://remote.example/users/a' }],
      cc: [{ '@id': 'https://www.w3.org/ns/activitystreams#Public' }]
    }))).toBe('unlisted');
  });

  test('validator rejects intent IDs outside the deterministic APDM v1 format', () => {
    const plan = {
      schema: 'ap.delivery-plan.v1',
      intentId: 'anything',
      activityId: 'https://pods.example/alice/activities/1',
      actorUri: ACTOR,
      activity: {
        id: 'https://pods.example/alice/activities/1',
        actor: ACTOR,
        type: 'Create'
      },
      localRecipients: [],
      remoteRecipients: [],
      meta: { visibility: 'direct', isPublicActivity: false }
    };
    expect(validateDeliveryPlanV1(plan)).toBe(false);
  });

  test('validator rejects activity/plan identity and visibility mismatches', () => {
    const activityId = 'https://pods.example/alice/activities/1';
    const id = createDeliveryIntentId({
      activityId,
      actorUri: ACTOR,
      localRecipientUris: [],
      remoteRecipientUris: []
    });
    const base = {
      schema: 'ap.delivery-plan.v1',
      intentId: id,
      activityId,
      actorUri: ACTOR,
      activity: {
        id: 'https://pods.example/alice/activities/other',
        actor: ACTOR,
        type: 'Create'
      },
      localRecipients: [],
      remoteRecipients: [],
      meta: { visibility: 'direct', isPublicActivity: false }
    };
    expect(validateDeliveryPlanV1(base)).toBe(false);
    expect(validateDeliveryPlanV1({
      ...base,
      activity: { ...base.activity, id: activityId, to: [`${ACTOR}/followers`] },
      meta: { visibility: 'direct', isPublicActivity: false }
    })).toBe(false);
  });

  test('validator rejects private/followers plans marked public-indexable', () => {
    const activityId = 'https://pods.example/alice/activities/private';
    const id = createDeliveryIntentId({
      activityId,
      actorUri: ACTOR,
      localRecipientUris: [],
      remoteRecipientUris: []
    });
    expect(validateDeliveryPlanV1({
      schema: 'ap.delivery-plan.v1',
      intentId: id,
      activityId,
      actorUri: ACTOR,
      activity: { id: activityId, actor: ACTOR, type: 'Create', to: [`${ACTOR}/followers`], cc: [] },
      localRecipients: [],
      remoteRecipients: [],
      meta: { visibility: 'followers', isPublicActivity: false, isPublicIndexable: true }
    })).toBe(false);
  });

  test('validator rejects duplicate/overlapping recipient actors and mismatched target domains', () => {
    const activityId = 'https://pods.example/alice/activities/1';
    const remoteActor = 'https://remote.example/users/bob';
    const id = createDeliveryIntentId({
      activityId,
      actorUri: ACTOR,
      localRecipientUris: [remoteActor],
      remoteRecipientUris: [remoteActor]
    });
    const plan = {
      schema: 'ap.delivery-plan.v1',
      intentId: id,
      activityId,
      actorUri: ACTOR,
      activity: { id: activityId, actor: ACTOR, type: 'Create' },
      localRecipients: [{ actorUri: remoteActor, dataset: 'bob', inboxUri: 'https://pods.example/bob/inbox' }],
      remoteRecipients: [{
        actorUri: remoteActor,
        inboxUrl: 'https://remote.example/users/bob/inbox',
        targetDomain: 'attacker.example'
      }],
      meta: { visibility: 'direct', isPublicActivity: false }
    };
    expect(validateDeliveryPlanV1(plan)).toBe(false);
  });

  test('planner rejects credential-bearing remote inbox and sharedInbox URLs', async () => {
    const ctx = {
      async call(action, params) {
        if (action !== 'activitypub.actor.get') throw new Error(`Unexpected ${action}`);
        return {
          id: params.actorUri,
          inbox: 'https://user:password@remote.example/users/bob/inbox'
        };
      }
    };
    await expect(buildDeliveryPlanV1(ctx, {
      activity: activity({ to: ['https://remote.example/users/bob'], cc: [] }),
      remoteRecipientUris: ['https://remote.example/users/bob']
    })).rejects.toThrow(/invalid remote inbox URL/u);

    const sharedInboxCtx = {
      async call(action, params) {
        if (action !== 'activitypub.actor.get') throw new Error(`Unexpected ${action}`);
        return {
          id: params.actorUri,
          inbox: 'https://remote.example/users/bob/inbox',
          endpoints: { sharedInbox: 'https://user:password@remote.example/inbox' }
        };
      }
    };
    await expect(buildDeliveryPlanV1(sharedInboxCtx, {
      activity: activity({ to: ['https://remote.example/users/bob'], cc: [] }),
      remoteRecipientUris: ['https://remote.example/users/bob']
    })).rejects.toThrow(/invalid remote shared inbox URL/u);
  });

  test('planner enforces one global resolution concurrency budget across local and remote targets', async () => {
    let active = 0;
    let maxActive = 0;
    const pause = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
    };
    const ctx = {
      async call(action, params) {
        await pause();
        if (action === 'auth.account.findByWebId') return { username: new URL(params.webId).pathname.split('/').pop() };
        if (action === 'activitypub.actor.getCollectionUri') return `${params.actorUri}/inbox`;
        if (action === 'activitypub.actor.get') {
          return { id: params.actorUri, inbox: `${params.actorUri}/inbox` };
        }
        throw new Error(`Unexpected ${action}`);
      }
    };

    await buildDeliveryPlanV1(ctx, {
      activity: activity({ to: ['https://www.w3.org/ns/activitystreams#Public'] }),
      localRecipientUris: ['https://pods.example/a', 'https://pods.example/b', 'https://pods.example/c'],
      remoteRecipientUris: ['https://one.example/u/a', 'https://two.example/u/b', 'https://three.example/u/c'],
      concurrency: 2
    });

    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
