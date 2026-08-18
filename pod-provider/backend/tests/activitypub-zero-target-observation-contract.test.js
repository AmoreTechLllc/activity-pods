'use strict';

const {
  REMOTE_DELIVERY_PLANNED_EVENT,
  createOutboxPostHandler
} = require('../lib/activitypub-service-with-delivery-strategy');

function externalSettings() {
  return {
    remoteDeliveryMode: 'external',
    allowExternalDeliveryPreview: true,
    podProvider: true,
    queueServiceUrl: 'redis://queue.example:6379',
    deliveryHandoffUrl: 'http://fedify-sidecar:8080/webhook/outbox',
    deliveryHandoffToken: 'secret',
    deliveryHandoffTimeoutMs: 1000
  };
}

describe('ActivityPods zero-target Stream1 observation contract', () => {
  test('committed external-mode activity still creates and durably queues one Delivery Plan with zero remote recipients', async () => {
    const activity = {
      id: 'https://pods.example/as/activity/local-only-public',
      type: 'Create',
      actor: 'https://pods.example/alice',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      object: {
        id: 'https://pods.example/notes/local-only-public',
        type: 'Note',
        content: 'provider-local public activity'
      }
    };

    const nativeHandler = jest.fn(async () => activity);
    const plan = {
      schema: 'ap.delivery-plan.v1',
      intentId: 'apdm-v1-local-only-public',
      activityId: activity.id,
      actorUri: activity.actor,
      activity,
      localRecipients: [],
      remoteRecipients: [],
      meta: {
        visibility: 'public',
        isPublicActivity: true,
        isPublicIndexable: true
      }
    };
    const buildDeliveryPlan = jest.fn(async (_ctx, input) => {
      expect(input.activity).toBe(activity);
      expect(input.localRecipientUris).toEqual([]);
      expect(input.remoteRecipientUris).toEqual([]);
      return plan;
    });
    const enqueueHandoff = jest.fn(async (_service, deliveryPlan) => deliveryPlan.intentId);
    const wrapped = createOutboxPostHandler(nativeHandler, { buildDeliveryPlan, enqueueHandoff });
    const broker = { emit: jest.fn() };
    const service = {
      settings: externalSettings(),
      createJob: jest.fn(),
      localPost: jest.fn(),
      broker
    };

    await expect(wrapped.call(service, { requestId: 'local-only-public' })).resolves.toBe(activity);

    expect(buildDeliveryPlan).toHaveBeenCalledTimes(1);
    expect(enqueueHandoff).toHaveBeenCalledTimes(1);
    expect(enqueueHandoff).toHaveBeenCalledWith(service, plan);
    expect(broker.emit).toHaveBeenCalledWith(
      REMOTE_DELIVERY_PLANNED_EVENT,
      expect.objectContaining({
        activity,
        deliveryPlan: plan,
        remoteRecipients: [],
        localRecipients: [],
        suppressedNativeRemotePostCount: 0,
        deliveryMode: 'external',
        durableHandoffQueued: true
      }),
      { meta: { webId: null } }
    );
  });

  test('zero remote recipients never causes synthetic remotePost work', async () => {
    const activity = {
      id: 'https://pods.example/as/activity/no-synthetic-recipient',
      type: 'Create',
      actor: 'https://pods.example/alice'
    };
    const createJob = jest.fn();
    const enqueueHandoff = jest.fn(async () => 'apdm-v1-no-synthetic-recipient');
    const wrapped = createOutboxPostHandler(async () => activity, {
      buildDeliveryPlan: async () => ({
        schema: 'ap.delivery-plan.v1',
        intentId: 'apdm-v1-no-synthetic-recipient',
        activityId: activity.id,
        actorUri: activity.actor,
        activity,
        localRecipients: [],
        remoteRecipients: [],
        meta: { visibility: 'public', isPublicActivity: true }
      }),
      enqueueHandoff
    });
    const service = {
      settings: externalSettings(),
      createJob,
      localPost: jest.fn(),
      broker: { emit: jest.fn() }
    };

    await wrapped.call(service, {});

    expect(createJob).not.toHaveBeenCalled();
    expect(enqueueHandoff).toHaveBeenCalledTimes(1);
  });
});
