'use strict';

const {
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

describe('APDM Phase 2 pre-event fail-closed interception', () => {
  test('invalid remotePost structure throws at createJob before later outbox code can run', async () => {
    const activity = {
      id: 'https://pods.example/as/activity/pre-event',
      actor: 'https://pods.example/alice'
    };
    const afterCreateJob = jest.fn();
    const buildDeliveryPlan = jest.fn();
    const enqueueHandoff = jest.fn();
    const wrapped = createOutboxPostHandler(async function nativePost() {
      this.createJob('remotePost', 'https://remote.example/users/bob', {
        recipientUri: 'https://remote.example/users/bob',
        activity: { id: activity.id }
      });
      afterCreateJob();
      this.broker.emit('activitypub.outbox.posted', { activity });
      this.localPost(['https://pods.example/bob'], activity);
      return activity;
    }, { buildDeliveryPlan, enqueueHandoff });
    const broker = { emit: jest.fn() };
    const localPost = jest.fn();
    const service = {
      settings: externalSettings(),
      createJob: jest.fn(),
      localPost,
      broker
    };

    await expect(wrapped.call(service, {})).rejects.toThrow(/concrete Activity id and actor/u);
    expect(afterCreateJob).not.toHaveBeenCalled();
    expect(broker.emit).not.toHaveBeenCalled();
    expect(localPost).not.toHaveBeenCalled();
    expect(buildDeliveryPlan).not.toHaveBeenCalled();
    expect(enqueueHandoff).not.toHaveBeenCalled();
  });
});
