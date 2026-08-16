'use strict';

process.env.SEMAPPS_AVAILABLE_LOCALES ||= 'en';
process.env.SEMAPPS_AUTH_RESERVED_USER_NAMES ||= 'admin';

const service = require('../services/activitypub-delivery-reconciler.service');

const SENDER = 'https://pods.example/alice';
const LOCAL_RECIPIENT = 'https://pods.example/bob';
const REMOTE_RECIPIENT = 'https://remote.example/users/carol';

function makeActivity(suffix, published) {
  return {
    id: `${SENDER}/activities/${suffix}`,
    type: 'Create',
    actor: SENDER,
    published,
    to: [LOCAL_RECIPIENT, REMOTE_RECIPIENT],
    cc: [],
    object: {
      id: `${SENDER}/objects/${suffix}`,
      type: 'Note',
      attributedTo: SENDER,
      content: suffix
    }
  };
}

test('reconciliation refreshes local account authority per activity while reusing the validated inbox', async () => {
  const published = new Date().toISOString();
  const activities = [makeActivity('one', published), makeActivity('two', published)];
  let accountAuthorityQueries = 0;
  let localInboxQueries = 0;
  let remoteActorGets = 0;
  const enqueued = [];

  const context = {
    settings: {
      baseUri: 'https://pods.example',
      accountsDataset: 'settings',
      lookbackMs: 900000,
      maxActivitiesPerAccount: 50
    },
    logger: { warn: jest.fn() },
    resolveLocalOutboxUri: service.methods.resolveLocalOutboxUri,
    listOutboxActivityPage: jest.fn(async () => ({
      rows: activities.map(item => ({
        activityUri: { value: item.id },
        published: { value: item.published }
      })),
      nextCursor: null
    })),
    reconcileActivity: service.methods.reconcileActivity,
    expandConcreteRecipients: service.methods.expandConcreteRecipients,
    findLocalAccountsByWebIds: service.methods.findLocalAccountsByWebIds,
    loadBlindRecipientSnapshot: jest.fn(async () => null)
  };

  const ctx = {
    call: jest.fn(async (action, params, options) => {
      if (action === 'triplestore.query') {
        if (params.dataset === 'alice' && params.query.includes('as:outbox ?outboxUri')) {
          expect(params.webId).toBe('system');
          return [{ outboxUri: { value: `${SENDER}/outbox` } }];
        }
        if (params.dataset === 'settings') {
          accountAuthorityQueries += 1;
          expect(params.webId).toBe('system');
          expect(params.query).toContain(`VALUES ?webId { <${LOCAL_RECIPIENT}> }`);
          return [{
            accountUri: { value: 'urn:account:bob' },
            webId: { value: LOCAL_RECIPIENT },
            username: { value: 'bob' }
          }];
        }
        if (params.dataset === 'bob') {
          localInboxQueries += 1;
          expect(params.webId).toBe('system');
          expect(params.query).toContain(`<${LOCAL_RECIPIENT}> ldp:inbox ?inboxUri`);
          return [{ inboxUri: { value: `${LOCAL_RECIPIENT}/inbox` } }];
        }
        throw new Error(`Unexpected triplestore dataset ${params.dataset}`);
      }
      if (action === 'activitypub.activity.get') {
        expect(options).toEqual({ meta: { dataset: 'alice' } });
        return activities.find(item => item.id === params.resourceUri);
      }
      if (action === 'activitypub.activity.getRecipients') {
        return [LOCAL_RECIPIENT, REMOTE_RECIPIENT];
      }
      if (action === 'activitypub.actor.get') {
        remoteActorGets += 1;
        return {
          id: params.actorUri,
          inbox: `${params.actorUri}/inbox`,
          endpoints: { sharedInbox: 'https://remote.example/inbox' }
        };
      }
      if (action === 'activitypub.outbox.enqueueDeliveryHandoff') {
        enqueued.push(params.deliveryPlan);
        return { intentId: params.deliveryPlan.intentId };
      }
      throw new Error(`Unexpected call ${action}`);
    })
  };

  const result = await service.methods.reconcileAccount.call(
    context,
    ctx,
    { webId: SENDER, username: 'alice' }
  );

  expect(result).toEqual({ activitiesScanned: 2, handoffsRequeued: 2, failures: 0 });
  expect(accountAuthorityQueries).toBe(2);
  expect(localInboxQueries).toBe(1);
  expect(remoteActorGets).toBe(1);
  expect(enqueued).toHaveLength(2);
  expect(enqueued.every(plan => plan.localRecipients[0]?.dataset === 'bob')).toBe(true);
});
