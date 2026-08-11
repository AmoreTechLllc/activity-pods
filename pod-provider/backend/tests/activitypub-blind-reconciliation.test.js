'use strict';

process.env.SEMAPPS_AVAILABLE_LOCALES ||= 'en';
process.env.SEMAPPS_AUTH_RESERVED_USER_NAMES ||= 'admin';

const service = require('../services/activitypub-delivery-reconciler.service');

describe('APDM blind recipient crash reconciliation', () => {
  test('snapshot identity survives persistence-assigned id and restores blind routing without leaking bcc into the plan', async () => {
    const hidden = 'https://remote.example/users/hidden';
    const prePersistenceActivity = {
      type: 'Create',
      actor: 'https://pods.example/alice',
      published: '2026-08-11T09:00:00.000Z',
      to: [],
      object: 'https://pods.example/alice/objects/1'
    };
    const persistedActivity = {
      id: 'https://pods.example/alice/activities/1',
      ...prePersistenceActivity
    };

    const values = new Map();
    const reconciliationRedis = {
      async set(key, value) {
        values.set(key, value);
        return 'OK';
      },
      async get(key) {
        return values.get(key) || null;
      }
    };
    const serviceContext = {
      settings: {
        enabled: true,
        baseUri: 'https://pods.example',
        blindSnapshotPrefix: 'apdm:test:blind:',
        blindSnapshotTtlSeconds: 3600
      },
      reconciliationRedis,
      loadBlindRecipientSnapshot: service.methods.loadBlindRecipientSnapshot,
      expandConcreteRecipients: service.methods.expandConcreteRecipients,
      logger: { debug: jest.fn() }
    };

    await expect(service.actions.storeBlindRecipientSnapshot.handler.call(serviceContext, {
      params: { activity: prePersistenceActivity, bcc: [hidden] }
    })).resolves.toEqual(expect.objectContaining({ stored: true }));

    await expect(service.methods.loadBlindRecipientSnapshot.call(serviceContext, persistedActivity))
      .resolves.toEqual({ bcc: [hidden] });

    const ctx = {
      async call(action, params) {
        if (action === 'activitypub.activity.getRecipients') {
          expect(params.activity.bcc).toEqual([hidden]);
          return params.activity.bcc;
        }
        if (action === 'activitypub.actor.get') {
          return {
            id: params.actorUri,
            inbox: 'https://remote.example/users/hidden/inbox'
          };
        }
        throw new Error(`Unexpected call ${action}`);
      }
    };

    const plan = await service.methods.reconcileActivity.call(serviceContext, ctx, persistedActivity, 'alice');
    expect(plan.remoteRecipients).toEqual([
      expect.objectContaining({ actorUri: hidden, inboxUrl: 'https://remote.example/users/hidden/inbox' })
    ]);
    expect(plan.activity.bcc).toBeUndefined();
    expect(JSON.stringify(plan.activity)).not.toContain('"bcc"');
  });
});
