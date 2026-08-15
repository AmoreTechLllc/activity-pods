'use strict';

const { buildDeliveryPlanV1 } = require('../utils/activitypub-delivery-planner');

const ACTOR = 'https://pods.example/alice';
const LOCAL = 'https://pods.example/bob';

function activity() {
  return {
    id: 'https://pods.example/alice/activities/pre-resolved-local',
    type: 'Create',
    actor: ACTOR,
    to: [LOCAL],
    cc: [],
    object: {
      id: 'https://pods.example/alice/objects/pre-resolved-local',
      type: 'Note',
      attributedTo: ACTOR,
      content: 'pre-resolved local target'
    }
  };
}

test('planner reuses an exact pre-resolved local account without querying auth.account again', async () => {
  const calls = [];
  const ctx = {
    async call(action, params, options) {
      calls.push({ action, params, options });
      if (action === 'activitypub.actor.getCollectionUri') return `${LOCAL}/inbox`;
      if (action === 'auth.account.findByWebId') throw new Error('duplicate account lookup');
      throw new Error(`Unexpected call ${action}`);
    }
  };

  const plan = await buildDeliveryPlanV1(ctx, {
    activity: activity(),
    localRecipientUris: [LOCAL],
    localRecipientAccounts: new Map([[LOCAL, { webId: LOCAL, username: 'bob' }]])
  });

  expect(plan.localRecipients).toEqual([
    { actorUri: LOCAL, dataset: 'bob', inboxUri: `${LOCAL}/inbox` }
  ]);
  expect(calls.some(call => call.action === 'auth.account.findByWebId')).toBe(false);
  expect(calls).toContainEqual({
    action: 'activitypub.actor.getCollectionUri',
    params: { actorUri: LOCAL, predicate: 'inbox', webId: 'system' },
    options: { meta: { dataset: 'bob' } }
  });
});

test('planner retains the original account lookup when no exact hint exists', async () => {
  const accountLookup = jest.fn(async () => ({ webId: LOCAL, username: 'bob' }));
  const ctx = {
    async call(action) {
      if (action === 'auth.account.findByWebId') return accountLookup();
      if (action === 'activitypub.actor.getCollectionUri') return `${LOCAL}/inbox`;
      throw new Error(`Unexpected call ${action}`);
    }
  };

  await buildDeliveryPlanV1(ctx, {
    activity: activity(),
    localRecipientUris: [LOCAL],
    localRecipientAccounts: new Map([['https://pods.example/other', { username: 'other' }]])
  });

  expect(accountLookup).toHaveBeenCalledTimes(1);
});

test('planner validates a supplied local account with the same dataset rules as a fetched account', async () => {
  const ctx = {
    call: jest.fn(async () => {
      throw new Error('planner should reject before inbox lookup');
    })
  };

  await expect(
    buildDeliveryPlanV1(ctx, {
      activity: activity(),
      localRecipientUris: [LOCAL],
      localRecipientAccounts: new Map([[LOCAL, { webId: LOCAL, username: '' }]])
    })
  ).rejects.toThrow(/Unable to resolve local dataset/u);

  expect(ctx.call).not.toHaveBeenCalled();
});

test('non-Map hint input is ignored and cannot bypass authoritative account resolution', async () => {
  const accountLookup = jest.fn(async () => ({ webId: LOCAL, username: 'bob' }));
  const ctx = {
    async call(action) {
      if (action === 'auth.account.findByWebId') return accountLookup();
      if (action === 'activitypub.actor.getCollectionUri') return `${LOCAL}/inbox`;
      throw new Error(`Unexpected call ${action}`);
    }
  };

  await buildDeliveryPlanV1(ctx, {
    activity: activity(),
    localRecipientUris: [LOCAL],
    localRecipientAccounts: { [LOCAL]: { username: 'forged' } }
  });

  expect(accountLookup).toHaveBeenCalledTimes(1);
});
