'use strict';

const { buildDeliveryPlanV1, resolveLocalInboxUri } = require('../utils/activitypub-delivery-planner');

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

function inboxRows(uri = `${LOCAL}/inbox`) {
  return [{ inboxUri: { type: 'uri', value: uri } }];
}

test('planner reuses an exact pre-resolved local account and selectively reads its authoritative inbox triple', async () => {
  const calls = [];
  const ctx = {
    async call(action, params, options) {
      calls.push({ action, params, options });
      if (action === 'triplestore.query') return inboxRows();
      if (action === 'auth.account.findByWebId') throw new Error('duplicate account lookup');
      if (action === 'activitypub.actor.getCollectionUri') throw new Error('heavy actor materialization path must not be used');
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
  expect(calls.some(call => call.action === 'activitypub.actor.getCollectionUri')).toBe(false);
  const queryCall = calls.find(call => call.action === 'triplestore.query');
  expect(queryCall).toBeDefined();
  expect(queryCall.params).toEqual(
    expect.objectContaining({ dataset: 'bob', webId: 'system' })
  );
  expect(queryCall.params.query).toContain('http://www.w3.org/ns/ldp#');
  expect(queryCall.params.query).toContain(`<${LOCAL}> ldp:inbox ?inboxUri`);
  expect(queryCall.params.query).toMatch(/LIMIT 2/u);
});

test('planner retains the original account lookup when no exact hint exists', async () => {
  const accountLookup = jest.fn(async () => ({ webId: LOCAL, username: 'bob' }));
  const ctx = {
    async call(action) {
      if (action === 'auth.account.findByWebId') return accountLookup();
      if (action === 'triplestore.query') return inboxRows();
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
      if (action === 'triplestore.query') return inboxRows();
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

test('selective inbox lookup fails closed when the actor has no authoritative inbox triple', async () => {
  const ctx = { call: jest.fn(async () => []) };

  await expect(resolveLocalInboxUri(ctx, LOCAL, 'bob')).rejects.toThrow(/Unable to resolve safe local inbox/u);
  expect(ctx.call).toHaveBeenCalledTimes(1);
});

test('selective inbox lookup fails closed when the actor has multiple distinct inbox triples', async () => {
  const ctx = {
    call: jest.fn(async () => [
      { inboxUri: { value: `${LOCAL}/inbox` } },
      { inboxUri: { value: `${LOCAL}/other-inbox` } }
    ])
  };

  await expect(resolveLocalInboxUri(ctx, LOCAL, 'bob')).rejects.toThrow(/unambiguous local inbox/u);
});

test('selective inbox lookup rejects a non-HTTP endpoint returned by the authoritative dataset', async () => {
  const ctx = { call: jest.fn(async () => inboxRows('javascript:alert(1)')) };

  await expect(resolveLocalInboxUri(ctx, LOCAL, 'bob')).rejects.toThrow(/Unable to resolve safe local inbox/u);
});