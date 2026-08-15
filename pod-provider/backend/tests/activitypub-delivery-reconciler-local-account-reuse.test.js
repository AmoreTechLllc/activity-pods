'use strict';

process.env.SEMAPPS_AVAILABLE_LOCALES ||= 'en';
process.env.SEMAPPS_AUTH_RESERVED_USER_NAMES ||= 'admin';

const service = require('../services/activitypub-delivery-reconciler.service');

const LOCAL = 'https://pods.example/bob';
const REMOTE = 'https://remote.example/users/carol';

test('reconcileActivity resolves each accepted local account once and reuses it in the planner', async () => {
  const accountLookup = jest.fn(async params => {
    expect(params).toEqual({ webId: LOCAL });
    return { webId: LOCAL, username: 'bob' };
  });
  const calls = [];
  const ctx = {
    async call(action, params, options) {
      calls.push({ action, params, options });
      if (action === 'activitypub.activity.getRecipients') return [LOCAL, REMOTE];
      if (action === 'auth.account.findByWebId') return accountLookup(params);
      if (action === 'activitypub.actor.getCollectionUri') {
        expect(params).toEqual({ actorUri: LOCAL, predicate: 'inbox', webId: 'system' });
        expect(options).toEqual({ meta: { dataset: 'bob' } });
        return `${LOCAL}/inbox`;
      }
      if (action === 'activitypub.actor.get') {
        expect(params).toEqual({ actorUri: REMOTE, webId: 'system' });
        return {
          id: REMOTE,
          inbox: `${REMOTE}/inbox`,
          endpoints: { sharedInbox: 'https://remote.example/inbox' }
        };
      }
      throw new Error(`Unexpected call ${action}`);
    }
  };
  const context = {
    settings: { baseUri: 'https://pods.example' },
    logger: { debug: jest.fn() },
    expandConcreteRecipients: service.methods.expandConcreteRecipients
  };
  const activity = {
    id: 'https://pods.example/alice/activities/reconcile-account-reuse',
    type: 'Create',
    actor: 'https://pods.example/alice',
    published: new Date().toISOString(),
    to: [LOCAL, REMOTE],
    cc: [],
    object: {
      id: 'https://pods.example/alice/objects/reconcile-account-reuse',
      type: 'Note',
      attributedTo: 'https://pods.example/alice',
      content: 'reuse local account metadata'
    }
  };

  const plan = await service.methods.reconcileActivity.call(context, ctx, activity, 'alice');

  expect(accountLookup).toHaveBeenCalledTimes(1);
  expect(plan.localRecipients).toEqual([
    { actorUri: LOCAL, dataset: 'bob', inboxUri: `${LOCAL}/inbox` }
  ]);
  expect(plan.remoteRecipients).toEqual([
    expect.objectContaining({ actorUri: REMOTE, targetDomain: 'remote.example' })
  ]);
  expect(calls.filter(call => call.action === 'auth.account.findByWebId')).toHaveLength(1);
});

test('reconcileActivity still skips a base-URI recipient that has no local account', async () => {
  const missing = 'https://pods.example/not-an-account';
  const accountLookup = jest.fn(async () => null);
  const ctx = {
    async call(action, params) {
      if (action === 'activitypub.activity.getRecipients') return [missing, REMOTE];
      if (action === 'auth.account.findByWebId') return accountLookup(params);
      if (action === 'activitypub.actor.get') {
        return { id: REMOTE, inbox: `${REMOTE}/inbox` };
      }
      if (action === 'activitypub.actor.getCollectionUri') {
        throw new Error('missing local account must never reach local inbox resolution');
      }
      throw new Error(`Unexpected call ${action}`);
    }
  };
  const context = {
    settings: { baseUri: 'https://pods.example' },
    logger: { debug: jest.fn() },
    expandConcreteRecipients: service.methods.expandConcreteRecipients
  };
  const activity = {
    id: 'https://pods.example/alice/activities/missing-local-account',
    type: 'Create',
    actor: 'https://pods.example/alice',
    to: [missing, REMOTE],
    cc: []
  };

  const plan = await service.methods.reconcileActivity.call(context, ctx, activity, 'alice');

  expect(accountLookup).toHaveBeenCalledTimes(1);
  expect(plan.localRecipients).toEqual([]);
  expect(plan.remoteRecipients).toHaveLength(1);
});
