'use strict';

const emitterSchema = require('../services/outbox-emitter.service');

function createActivity() {
  return {
    id: 'https://pods.example/alice/activities/phase3-emitter',
    type: 'Create',
    actor: 'https://pods.example/alice',
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: ['https://pods.example/alice/followers'],
    object: {
      id: 'https://pods.example/alice/objects/phase3-emitter',
      type: 'Note',
      attributedTo: 'https://pods.example/alice',
      content: 'hello #phase3'
    }
  };
}

function createPlan(activity) {
  return {
    schema: 'ap.delivery-plan.v1',
    intentId: 'apdm-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    activityId: activity.id,
    actorUri: activity.actor,
    activity,
    localRecipients: [
      {
        actorUri: 'https://pods.example/bob',
        dataset: 'bob',
        inboxUri: 'https://pods.example/bob/inbox'
      }
    ],
    remoteRecipients: [
      {
        actorUri: 'https://remote.example/users/carol',
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
  service.deliverToSidecar = jest.fn(async () => undefined);
  return service;
}

describe('APDM Phase 3 outbox emitter Delivery Plan authority', () => {
  test('external mode ignores raw outbox.posted before any legacy target resolution', async () => {
    const service = createService('external');
    const ctx = {
      params: { activity: createActivity() },
      call: jest.fn(async () => {
        throw new Error('legacy resolver must not execute');
      }),
      emit: jest.fn()
    };

    await emitterSchema.events['activitypub.outbox.posted'].handler.call(service, ctx);

    expect(ctx.call).not.toHaveBeenCalled();
    expect(service.buildSearchConsent).not.toHaveBeenCalled();
    expect(ctx.emit).not.toHaveBeenCalled();
    expect(service.deliverToSidecar).not.toHaveBeenCalled();
    expect(service.logger.debug).toHaveBeenCalledWith(
      'Ignoring raw outbox.posted routing event in APDM external preview mode'
    );
  });

  test('native mode retains the legacy raw resolver path', async () => {
    const service = createService('native');
    const activity = createActivity();
    const ctx = {
      params: { activity },
      meta: { podDataset: 'alice' },
      call: jest.fn(async (action) => {
        if (action === 'outbox-emitter.resolveDeliveryTargets') {
          return {
            targets: [
              {
                targetDomain: 'remote.example',
                inboxUrl: 'https://remote.example/users/carol/inbox',
                sharedInboxUrl: 'https://remote.example/inbox'
              }
            ]
          };
        }
        throw new Error(`Unexpected call ${action}`);
      }),
      emit: jest.fn()
    };

    await emitterSchema.events['activitypub.outbox.posted'].handler.call(service, ctx);

    expect(ctx.call).toHaveBeenCalledWith('outbox-emitter.resolveDeliveryTargets', {
      actorUri: activity.actor,
      activity
    });
    expect(service.deliverToSidecar).toHaveBeenCalledTimes(1);
    const [, committed] = ctx.emit.mock.calls[0];
    expect(committed.deliveryTargets).toEqual([
      {
        targetDomain: 'remote.example',
        inboxUrl: 'https://remote.example/users/carol/inbox',
        sharedInboxUrl: 'https://remote.example/inbox'
      }
    ]);
    expect(committed.meta.deliveryPlanIntentId).toBeUndefined();
  });

  test('external planned event consumes only validated concrete remote targets', async () => {
    const service = createService('external');
    const activity = createActivity();
    const deliveryPlan = createPlan(activity);
    const ctx = {
      params: { activity, deliveryPlan },
      meta: { podDataset: 'alice' },
      call: jest.fn(),
      emit: jest.fn()
    };

    await emitterSchema.events['activitypub.outbox.remote-delivery.planned'].handler.call(service, ctx);

    expect(ctx.call).not.toHaveBeenCalled();
    expect(service.deliverToSidecar).toHaveBeenCalledTimes(1);
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

  test('planned event rejects an invalid Delivery Plan before sidecar delivery', async () => {
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
      emitterSchema.events['activitypub.outbox.remote-delivery.planned'].handler.call(service, ctx)
    ).rejects.toThrow(/Refusing invalid ap\.delivery-plan\.v1 payload/u);

    expect(ctx.emit).not.toHaveBeenCalled();
    expect(service.deliverToSidecar).not.toHaveBeenCalled();
  });

  test('planned event rejects activity identity mismatches', async () => {
    const service = createService('external');
    const activity = createActivity();
    const deliveryPlan = {
      ...createPlan(activity),
      activityId: 'https://pods.example/alice/activities/other'
    };
    const ctx = {
      params: { activity, deliveryPlan },
      emit: jest.fn()
    };

    await expect(
      emitterSchema.events['activitypub.outbox.remote-delivery.planned'].handler.call(service, ctx)
    ).rejects.toThrow(/activityId does not match/u);

    expect(ctx.emit).not.toHaveBeenCalled();
    expect(service.deliverToSidecar).not.toHaveBeenCalled();
  });

  test('native mode ignores the Phase 3 planned event', async () => {
    const service = createService('native');
    const activity = createActivity();
    const ctx = {
      params: { activity, deliveryPlan: createPlan(activity) },
      emit: jest.fn()
    };

    await emitterSchema.events['activitypub.outbox.remote-delivery.planned'].handler.call(service, ctx);

    expect(ctx.emit).not.toHaveBeenCalled();
    expect(service.deliverToSidecar).not.toHaveBeenCalled();
  });
});
