'use strict';

process.env.SEMAPPS_AVAILABLE_LOCALES ||= 'en';
process.env.SEMAPPS_AUTH_RESERVED_USER_NAMES ||= 'admin';

const service = require('../services/activitypub-delivery-reconciler.service');

function context() {
  return {
    settings: {
      baseUri: 'https://pods.example',
      accountsDataset: 'settings'
    },
    logger: { debug: jest.fn(), warn: jest.fn() },
    expandConcreteRecipients: service.methods.expandConcreteRecipients,
    findLocalAccountsByWebIds: service.methods.findLocalAccountsByWebIds
  };
}

function binding(webId, username) {
  return {
    accountUri: { value: `urn:account:${username}` },
    webId: { value: webId },
    username: { value: username }
  };
}

test('resolves local recipient accounts in one bounded authoritative query instead of one action per recipient', async () => {
  const locals = ['https://pods.example/bob', 'https://pods.example/carol'];
  const remote = 'https://remote.example/users/dave';
  const calls = [];
  const ctx = {
    async call(action, params, options) {
      calls.push({ action, params, options });
      if (action === 'activitypub.activity.getRecipients') return [...locals, remote];
      if (action === 'triplestore.query') {
        expect(params.dataset).toBe('settings');
        expect(params.webId).toBe('system');
        expect(params.query).toContain('VALUES ?webId');
        expect(params.query).toContain('<https://pods.example/bob>');
        expect(params.query).toContain('<https://pods.example/carol>');
        expect(params.query).toContain('FILTER NOT EXISTS { ?accountUri semapps:deletedAt ?deletedAt . }');
        return [binding(locals[0], 'bob'), binding(locals[1], 'carol')];
      }
      if (action === 'activitypub.actor.getCollectionUri') {
        const username = params.actorUri.endsWith('/bob') ? 'bob' : 'carol';
        expect(options).toEqual({ meta: { dataset: username } });
        return `${params.actorUri}/inbox`;
      }
      if (action === 'activitypub.actor.get') {
        return { id: remote, inbox: `${remote}/inbox` };
      }
      if (action === 'auth.account.findByWebId') throw new Error('per-recipient account lookup must not run');
      throw new Error(`Unexpected call ${action}`);
    }
  };
  const activity = {
    id: 'https://pods.example/alice/activities/batched-local-accounts',
    type: 'Create',
    actor: 'https://pods.example/alice',
    to: [...locals, remote],
    cc: []
  };

  const plan = await service.methods.reconcileActivity.call(context(), ctx, activity, 'alice');

  expect(plan.localRecipients.map(target => target.actorUri)).toEqual(locals);
  expect(plan.remoteRecipients.map(target => target.actorUri)).toEqual([remote]);
  expect(calls.filter(call => call.action === 'triplestore.query')).toHaveLength(1);
  expect(calls.some(call => call.action === 'auth.account.findByWebId')).toBe(false);
});

test('chunks local account queries at 250 WebIDs and deduplicates candidates before querying', async () => {
  const webIds = Array.from({ length: 501 }, (_, index) => `https://pods.example/user-${index}`);
  const queries = [];
  const ctx = {
    call: jest.fn(async (action, params) => {
      expect(action).toBe('triplestore.query');
      queries.push(params.query);
      return [];
    })
  };

  const result = await service.methods.findLocalAccountsByWebIds.call(
    context(),
    ctx,
    [...webIds, webIds[0], webIds[250]]
  );

  expect(result.size).toBe(0);
  expect(queries).toHaveLength(3);
  expect((queries[0].match(/<https:\/\/pods\.example\/user-/gu) || []).length).toBe(250);
  expect((queries[1].match(/<https:\/\/pods\.example\/user-/gu) || []).length).toBe(250);
  expect((queries[2].match(/<https:\/\/pods\.example\/user-/gu) || []).length).toBe(1);
});

test('also chunks by rendered IRI payload size before reaching the count limit', async () => {
  const longTail = 'x'.repeat(3900);
  const webIds = Array.from({ length: 40 }, (_, index) => `https://pods.example/${index}-${longTail}`);
  const queries = [];
  const ctx = {
    call: jest.fn(async (_action, params) => {
      queries.push(params.query);
      return [];
    })
  };

  await service.methods.findLocalAccountsByWebIds.call(context(), ctx, webIds);

  expect(queries.length).toBeGreaterThan(1);
  for (const query of queries) {
    const values = query.match(/VALUES \?webId \{ ([\s\S]*?) \}/u)?.[1] || '';
    expect(Buffer.byteLength(values, 'utf8')).toBeLessThanOrEqual(65536);
  }
});

test('rejects unsafe SPARQL IRI input instead of interpolating it into VALUES', async () => {
  const ctx = { call: jest.fn() };

  await expect(
    service.methods.findLocalAccountsByWebIds.call(context(), ctx, [
      'https://pods.example/bob> } UNION { ?s ?p ?o'
    ])
  ).rejects.toThrow();

  expect(ctx.call).not.toHaveBeenCalled();
});

test('rejects overlong local WebIDs before constructing a query', async () => {
  const ctx = { call: jest.fn() };

  await expect(
    service.methods.findLocalAccountsByWebIds.call(context(), ctx, [
      `https://pods.example/${'x'.repeat(5000)}`
    ])
  ).rejects.toThrow(/exceeds 4096 characters/u);

  expect(ctx.call).not.toHaveBeenCalled();
});

test('fails closed when authoritative rows conflict for the same WebID', async () => {
  const webId = 'https://pods.example/bob';
  const ctx = {
    call: jest.fn(async () => [
      binding(webId, 'bob'),
      {
        accountUri: { value: 'urn:account:other-bob' },
        webId: { value: webId },
        username: { value: 'bob2' }
      }
    ])
  };

  await expect(
    service.methods.findLocalAccountsByWebIds.call(context(), ctx, [webId])
  ).rejects.toThrow(/Ambiguous local ActivityPub account records/u);
});

test('missing local-looking recipient preserves the planner fail-closed coverage invariant', async () => {
  const missing = 'https://pods.example/not-an-account';
  const remote = 'https://remote.example/users/dave';
  const ctx = {
    async call(action) {
      if (action === 'activitypub.activity.getRecipients') return [missing, remote];
      if (action === 'triplestore.query') return [];
      if (action === 'activitypub.actor.get') return { id: remote, inbox: `${remote}/inbox` };
      throw new Error(`Unexpected call ${action}`);
    }
  };
  const activity = {
    id: 'https://pods.example/alice/activities/missing-batched-local',
    type: 'Create',
    actor: 'https://pods.example/alice',
    to: [missing, remote],
    cc: []
  };

  await expect(service.methods.reconcileActivity.call(context(), ctx, activity, 'alice')).rejects.toThrow(
    /omitted explicitly addressed recipient/u
  );
});
