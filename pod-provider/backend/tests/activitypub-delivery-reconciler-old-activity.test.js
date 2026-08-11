'use strict';

const service = require('../services/activitypub-delivery-reconciler.service');

test('APDM P4 reconciler skips persisted activities outside the lookback window', async () => {
  const oldPublished = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const enqueued = jest.fn();
  const ctx = {
    async call(action, params) {
      if (action === 'activitypub.actor.getCollectionUri') return 'https://pods.example/alice/outbox';
      if (action === 'triplestore.query') {
        return [{
          activityUri: { value: 'https://pods.example/alice/activities/old' },
          published: { value: oldPublished }
        }];
      }
      if (action === 'activitypub.activity.get') {
        return {
          id: 'https://pods.example/alice/activities/old',
          actor: 'https://pods.example/alice',
          published: oldPublished,
          to: ['https://remote.example/users/bob']
        };
      }
      if (action === 'activitypub.outbox.enqueueDeliveryHandoff') {
        enqueued();
        return {};
      }
      throw new Error(`Unexpected call ${action}`);
    }
  };
  const context = {
    settings: {
      baseUri: 'https://pods.example',
      lookbackMs: 15 * 60 * 1000,
      maxActivitiesPerAccount: 50
    },
    logger: { warn: jest.fn() }
  };

  const result = await service.methods.reconcileAccount.call(
    context,
    ctx,
    { webId: 'https://pods.example/alice', username: 'alice' }
  );

  expect(result).toEqual({ activitiesScanned: 1, handoffsRequeued: 0, failures: 0 });
  expect(enqueued).not.toHaveBeenCalled();
});
