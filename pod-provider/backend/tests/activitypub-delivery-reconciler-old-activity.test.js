'use strict';

process.env.SEMAPPS_AVAILABLE_LOCALES ||= 'en';
process.env.SEMAPPS_AUTH_RESERVED_USER_NAMES ||= 'admin';

const service = require('../services/activitypub-delivery-reconciler.service');

test('APDM P4 reconciler skips persisted activities outside the lookback window', async () => {
  const oldPublished = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const enqueued = jest.fn();
  const ctx = {
    async call(action, params) {
      if (action === 'activitypub.actor.getCollectionUri') {
        throw new Error('heavy actor materialization path must not be used by reconciliation');
      }
      if (action === 'triplestore.query') {
        expect(params.dataset).toBe('alice');
        expect(params.webId).toBe('system');
        if (params.query.includes('as:outbox ?outboxUri')) {
          return [{ outboxUri: { value: 'https://pods.example/alice/outbox' } }];
        }
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
    resolveLocalOutboxUri: service.methods.resolveLocalOutboxUri,
    reconcileActivity: service.methods.reconcileActivity,
    expandConcreteRecipients: service.methods.expandConcreteRecipients,
    listOutboxActivityPage: service.methods.listOutboxActivityPage,
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
