'use strict';

const emitterSchema = require('../services/outbox-emitter.service');
const { createDeliveryIntentId } = require('../utils/activitypub-delivery-planner');

function createActivity() {
  return {
    id: 'https://pods.example/alice/activities/phase6-emitter',
    type: 'Create',
    actor: 'https://pods.example/alice',
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: ['https://pods.example/alice/followers'],
    object: {
      id: 'https://pods.example/alice/objects/phase6-emitter',
      type: 'Note',
      attributedTo: 'https://pods.example/alice',
      content: 'hello #phase6'
    }
  };
}

function createPlan(activity) {
  const localRecipientUris = ['https://pods.example/bob'];
  const remoteRecipientUris = ['https://remote.example/users/carol'];
  return {
    schema: 'ap.delivery-plan.v1',
    intentId: createDeliveryIntentId({
      activityId: activity.id,
      actorUri: activity.actor,
      localRecipientUris,
      remoteRecipientUris
    }),
    activityId: activity.id,
    actorUri: activity.actor,
    activity,
    localRecipients: [
      {
        actorUri: localRecipientUris[0],
        dataset: 'bob',
        inboxUri: 'https://pods.example/bob/inbox'
      }
    ],
    remoteRecipients: [
      {
        actorUri: remoteRecipientUris[0],
        inboxUrl: 'https://remote.example/users/carol/inbox',
        sharedInboxUrl: 'https://remote.example/inbox',
        targetDomain: 'remote.example'
      }
    ],
    meta: {
      visibility: 'public',
      isPublicActivity: true
    }
  };
}

function createService(mode) {
  const service = {
    settings: {
      ...emitterSchema.settings,
      remoteDeliveryMode: mode
    },
    logger: {
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }
  };

  for (const [name, method] of Object.entries(emitterSchema.methods)) {
    service[name] = method;
  }

  service.buildSearchConsent = jest.fn(async () => ({ raw: [], isPublic: true, explicitlySet: false }));
  return service;
}

describe('APDM Phase 6 outbox routing authority', () => {
  test('external mode ignores raw outbox.posted before any legacy target resolution', async () => {
    const service = createService('external');
    const ctx = {
      params: { activity: createActivity() },
      call: jest.fn(async () => {
        throw new Error('raw recipient routing must not execute');
      }),
      emit: jest.fn()
    };

    await emitterSchema.events['activitypub.outbox.posted'].handler.call(service, ctx);

    expect(ctx.call).not.toHaveBeenCalled();
    expect(service.buildSearchConsent).not.toHaveBeenCalled();
    expect(ctx.emit).not.toHaveBeenCalled();
    expect(service.logger.debug).toHaveBeenCalledWith('Ignoring raw outbox.posted routing event in APDM external mode');
  });

  test('native rollback observes the committed Activity without inferring or submitting remote targets', async () => {
    const service = createService('native');
    const activity = createActivity();
    const ctx = {
      params: { activity },
      meta: { podDataset: 'alice' },
      call: jest.fn(async action => {
        if (action === 'activitypub.actor.get') return { id: activity.actor };
        throw new Error(`Unexpected call ${action}`);
      }),
      emit: jest.fn()
    };

    await emitterSchema.events['activitypub.outbox.posted'].handler.call(service, ctx);

    expect(ctx.call).toHaveBeenCalledTimes(1);
    expect(ctx.call).toHaveBeenCalledWith('activitypub.actor.get', {
      actorUri: activity.actor,
      webId: 'system'
    });
    expect(ctx.emit).toHaveBeenCalledTimes(1);
    const [eventName, committed] = ctx.emit.mock.calls[0];
    expect(eventName).toBe('outbox.event.ready');
    expect(committed.deliveryTargets).toEqual([]);
    expect(committed.meta.deliveryPlanIntentId).toBeUndefined();
  });

  test('external post-durable event consumes only validated concrete remote targets', async () => {
    const service = createService('external');
    const activity = createActivity();
    const deliveryPlan = createPlan(activity);
    const ctx = {
      params: { activity, deliveryPlan },
      meta: { podDataset: 'alice' },
      call: jest.fn(),
      emit: jest.fn()
    };

    await emitterSchema.events['activitypub.outbox.remote-delivery.handoff-queued'].handler.call(service, ctx);

    expect(ctx.call).not.toHaveBeenCalled();
    expect(ctx.emit).toHaveBeenCalledTimes(1);
    const [eventName, committed] = ctx.emit.mock.calls[0];
    expect(eventName).toBe('outbox.event.ready');
    expect(committed.deliveryTargets).toEqual([
      {
        targetDomain: 'remote.example',
        inboxUrl: 'https://remote.example/users/carol/inbox',
        sharedInboxUrl: 'https://remote.example/inbox'
      }
    ]);
    expect(committed.deliveryTargets.some(target => target.inboxUrl.endsWith('/followers'))).toBe(false);
    expect(committed.meta.deliveryPlanIntentId).toBe(deliveryPlan.intentId);
    expect(committed.meta.visibility).toBe('public');
  });

  test('post-durable event rejects an invalid Delivery Plan before local readiness', async () => {
    const service = createService('external');
    const activity = createActivity();
    const invalidPlan = {
      ...createPlan(activity),
      remoteRecipients: [
        {
          actorUri: 'https://remote.example/users/carol',
          inboxUrl: 'https://remote.example/users/carol/followers',
          targetDomain: 'remote.example',
          unexpected: true
        }
      ]
    };
    const ctx = {
      params: { activity, deliveryPlan: invalidPlan },
      emit: jest.fn()
    };

    await expect(
      emitterSchema.events['activitypub.outbox.remote-delivery.handoff-queued'].handler.call(service, ctx)
    ).rejects.toThrow(/Refusing invalid ap\.delivery-plan\.v1 payload/u);

    expect(ctx.emit).not.toHaveBeenCalled();
  });

  test('post-durable event rejects activity identity mismatches', async () => {
    const service = createService('external');
    const activity = createActivity();
    const deliveryPlan = createPlan(activity);
    const otherActivity = {
      ...activity,
      id: 'https://pods.example/alice/activities/other'
    };
    const ctx = {
      params: { activity: otherActivity, deliveryPlan },
      emit: jest.fn()
    };

    await expect(
      emitterSchema.events['activitypub.outbox.remote-delivery.handoff-queued'].handler.call(service, ctx)
    ).rejects.toThrow(/activityId does not match/u);

    expect(ctx.emit).not.toHaveBeenCalled();
  });

  test('native mode ignores the external post-durable event', async () => {
    const service = createService('native');
    const activity = createActivity();
    const ctx = {
      params: { activity, deliveryPlan: createPlan(activity) },
      emit: jest.fn()
    };

    await emitterSchema.events['activitypub.outbox.remote-delivery.handoff-queued'].handler.call(service, ctx);

    expect(ctx.emit).not.toHaveBeenCalled();
  });
});
