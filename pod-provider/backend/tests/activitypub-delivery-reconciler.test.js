'use strict';

process.env.SEMAPPS_AVAILABLE_LOCALES ||= 'en';
process.env.SEMAPPS_AUTH_RESERVED_USER_NAMES ||= 'admin';

const service = require('../services/activitypub-delivery-reconciler.service');

function createServiceContext(overrides = {}) {
  let accountCursor = null;
  return {
    settings: {
      enabled: true,
      baseUri: 'https://pods.example',
      intervalMs: 60000,
      lookbackMs: 900000,
      accountBatchSize: 100,
      maxActivitiesPerAccount: 50,
      concurrency: 2,
      accountsDataset: 'settings',
      ...overrides
    },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    reconcileAccount: service.methods.reconcileAccount,
    reconcileActivity: service.methods.reconcileActivity,
    expandConcreteRecipients: service.methods.expandConcreteRecipients,
    findLocalAccountsByWebIds: service.methods.findLocalAccountsByWebIds,
    listAccountPage: service.methods.listAccountPage,
    listOutboxActivityPage: service.methods.listOutboxActivityPage,
    acquireDistributedLease: jest.fn(async () => 'lease-token'),
    releaseDistributedLease: jest.fn(async () => true),
    getAccountCursor: jest.fn(async () => accountCursor),
    setAccountCursor: jest.fn(async next => {
      accountCursor = next;
    }),
    reconciliationRunning: false,
    reconciliationStats: {
      runs: 0,
      accountsScanned: 0,
      activitiesScanned: 0,
      handoffsRequeued: 0,
      failures: 0,
      accountOffset: 0,
      accountCursor: null,
      distributedLockSkips: 0,
      lastRunStartedAt: null,
      lastRunCompletedAt: null,
      lastError: null
    }
  };
}

function createContext({ includeRemote = true, unresolvedFollowers = false } = {}) {
  const enqueuedPlans = [];
  const activity = {
    id: 'https://pods.example/alice/activities/recover-me',
    type: 'Create',
    actor: 'https://pods.example/alice',
    published: new Date().toISOString(),
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: ['https://pods.example/alice/followers'],
    object: {
      id: 'https://pods.example/alice/objects/recover-me',
      type: 'Note',
      attributedTo: 'https://pods.example/alice',
      content: 'recover me'
    }
  };

  const ctx = {
    async call(action, params, options) {
      switch (action) {
        case 'auth.account.find':
          return [{ webId: 'https://pods.example/alice', username: 'alice' }];
        case 'activitypub.actor.getCollectionUri':
          if (params.predicate === 'outbox') return 'https://pods.example/alice/outbox';
          if (params.predicate === 'inbox') return `${params.actorUri}/inbox`;
          throw new Error(`Unexpected predicate ${params.predicate}`);
        case 'triplestore.query':
          if (params.dataset === 'settings') {
            expect(params.query).toContain('VALUES ?webId');
            expect(params.query).toContain('<https://pods.example/bob>');
            expect(params.webId).toBe('system');
            return [{
              accountUri: { value: 'urn:account:bob' },
              webId: { value: 'https://pods.example/bob' },
              username: { value: 'bob' }
            }];
          }
          expect(params.query).toContain('LIMIT 50');
          expect(params.query).not.toContain('OFFSET');
          expect(params.query).toContain('ORDER BY DESC(STR(?published)) ASC(STR(?activityUri))');
          expect(params.dataset).toBe('alice');
          return [{ activityUri: { value: activity.id }, published: { value: activity.published } }];
        case 'activitypub.activity.get':
          expect(options).toEqual({ meta: { dataset: 'alice' } });
          return activity;
        case 'activitypub.activity.getRecipients':
          if (unresolvedFollowers) return ['https://pods.example/alice/followers'];
          return includeRemote
            ? ['https://pods.example/bob', 'https://remote.example/users/carol']
            : ['https://pods.example/bob'];
        case 'activitypub.collection.get':
          expect(params.resourceUri).toBe('https://pods.example/alice/followers');
          return {
            id: params.resourceUri,
            type: 'Collection',
            items: ['https://pods.example/bob', 'https://remote.example/users/carol']
          };
        case 'auth.account.findByWebId':
          throw new Error('reconciliation must use bounded batch account lookup');
        case 'activitypub.actor.get':
          return {
            id: params.actorUri,
            inbox: 'https://remote.example/users/carol/inbox',
            endpoints: { sharedInbox: 'https://remote.example/inbox' }
          };
        case 'activitypub.outbox.enqueueDeliveryHandoff':
          enqueuedPlans.push(params.deliveryPlan);
          return { intentId: params.deliveryPlan.intentId };
        default:
          throw new Error(`Unexpected call ${action}`);
      }
    }
  };

  return { ctx, activity, enqueuedPlans };
}

describe('APDM Phase 4 delivery reconciliation', () => {
  test('rebuilds a persisted remote Delivery Plan and re-enqueues its stable handoff ID', async () => {
    const { ctx, enqueuedPlans } = createContext();
    const serviceContext = createServiceContext();

    const result = await service.methods.reconcileAccount.call(
      serviceContext,
      ctx,
      { webId: 'https://pods.example/alice', username: 'alice' }
    );

    expect(result).toEqual({ activitiesScanned: 1, handoffsRequeued: 1, failures: 0 });
    expect(enqueuedPlans).toHaveLength(1);
    expect(enqueuedPlans[0]).toEqual(
      expect.objectContaining({
        schema: 'ap.delivery-plan.v1',
        activityId: 'https://pods.example/alice/activities/recover-me',
        actorUri: 'https://pods.example/alice',
        localRecipients: [expect.objectContaining({ actorUri: 'https://pods.example/bob', dataset: 'bob' })],
        remoteRecipients: [expect.objectContaining({
          actorUri: 'https://remote.example/users/carol',
          sharedInboxUrl: 'https://remote.example/inbox'
        })]
      })
    );
  });

  test('expands an unresolved local followers collection before rebuilding the plan', async () => {
    const { ctx, enqueuedPlans } = createContext({ unresolvedFollowers: true });
    const serviceContext = createServiceContext();

    const result = await service.methods.reconcileAccount.call(
      serviceContext,
      ctx,
      { webId: 'https://pods.example/alice', username: 'alice' }
    );

    expect(result).toEqual({ activitiesScanned: 1, handoffsRequeued: 1, failures: 0 });
    expect(enqueuedPlans).toHaveLength(1);
    expect(enqueuedPlans[0].remoteRecipients).toEqual([
      expect.objectContaining({ actorUri: 'https://remote.example/users/carol' })
    ]);
    expect(JSON.stringify(enqueuedPlans[0].remoteRecipients)).not.toContain('/followers');
  });

  test('repeated reconciliation of the same persisted activity generates the same intent ID', async () => {
    const { ctx, enqueuedPlans } = createContext();
    const serviceContext = createServiceContext();
    const account = { webId: 'https://pods.example/alice', username: 'alice' };

    await service.methods.reconcileAccount.call(serviceContext, ctx, account);
    await service.methods.reconcileAccount.call(serviceContext, ctx, account);

    expect(enqueuedPlans).toHaveLength(2);
    expect(enqueuedPlans[0].intentId).toBe(enqueuedPlans[1].intentId);
    expect(enqueuedPlans[0].intentId).toMatch(/^apdm-v1-[a-f0-9]{64}$/u);
  });

  test('does not enqueue a sidecar handoff for activities with only local recipients', async () => {
    const { ctx, enqueuedPlans } = createContext({ includeRemote: false });
    const serviceContext = createServiceContext();

    const result = await service.methods.reconcileAccount.call(
      serviceContext,
      ctx,
      { webId: 'https://pods.example/alice', username: 'alice' }
    );

    expect(result).toEqual({ activitiesScanned: 1, handoffsRequeued: 0, failures: 0 });
    expect(enqueuedPlans).toHaveLength(0);
  });

  test('pages beyond the newest activity batch so an older missed handoff inside lookback is repaired', async () => {
    const serviceContext = createServiceContext({ maxActivitiesPerAccount: 2, lookbackMs: 60 * 60 * 1000 });
    const now = Date.now();
    const activities = [0, 1, 2].map(index => ({
      id: `https://pods.example/alice/activities/${index}`,
      type: 'Create',
      actor: 'https://pods.example/alice',
      published: new Date(now - index * 1000).toISOString()
    }));
    const enqueued = [];
    const cursors = [];
    serviceContext.listOutboxActivityPage = jest.fn(async (_ctx, { cursor }) => {
      cursors.push(cursor);
      const start = cursor ? 2 : 0;
      const page = activities.slice(start, start + 2);
      return {
        rows: page.map(activity => ({
          activityUri: { value: activity.id },
          published: { value: activity.published }
        })),
        nextCursor: page.length
          ? { published: page[page.length - 1].published, activityUri: page[page.length - 1].id }
          : cursor
      };
    });
    const ctx = {
      async call(action, params) {
        if (action === 'activitypub.actor.getCollectionUri') return 'https://pods.example/alice/outbox';
        if (action === 'activitypub.activity.get') {
          return activities.find(activity => activity.id === params.resourceUri);
        }
        if (action === 'activitypub.activity.getRecipients') return ['https://remote.example/users/bob'];
        if (action === 'activitypub.actor.get') {
          return { id: params.actorUri, inbox: 'https://remote.example/users/bob/inbox' };
        }
        if (action === 'activitypub.outbox.enqueueDeliveryHandoff') {
          enqueued.push(params.deliveryPlan.activityId);
          return { intentId: params.deliveryPlan.intentId };
        }
        throw new Error(`Unexpected call ${action}`);
      }
    };

    const result = await service.methods.reconcileAccount.call(
      serviceContext,
      ctx,
      { webId: 'https://pods.example/alice', username: 'alice' }
    );

    expect(cursors).toEqual([
      null,
      { published: activities[1].published, activityUri: activities[1].id }
    ]);
    expect(result).toEqual({ activitiesScanned: 3, handoffsRequeued: 3, failures: 0 });
    expect(enqueued).toEqual(activities.map(activity => activity.id));
  });

  test('run skips overlapping reconciliation in the same process', async () => {
    const context = createServiceContext();
    context.reconciliationRunning = true;

    const result = await service.actions.run.handler.call(context, { call: jest.fn() });

    expect(result).toEqual({ skipped: true, reason: 'reconciliation already running' });
    expect(context.acquireDistributedLease).not.toHaveBeenCalled();
  });

  test('run skips when another provider process owns the distributed reconciliation lease', async () => {
    const context = createServiceContext();
    context.acquireDistributedLease = jest.fn(async () => null);

    const result = await service.actions.run.handler.call(context, { call: jest.fn() });

    expect(result).toEqual({ skipped: true, reason: 'reconciliation active on another provider process' });
    expect(context.reconciliationStats.distributedLockSkips).toBe(1);
    expect(context.reconciliationStats.runs).toBe(0);
  });

  test('run advances the durable keyset cursor and releases its lease', async () => {
    const context = createServiceContext({ accountBatchSize: 2 });
    context.getAccountCursor = jest.fn(async () => null);
    context.listAccountPage = jest.fn(async () => ({
      accounts: [
        { '@id': 'urn:AuthAccount:001', webId: 'https://pods.example/alice', username: 'alice' },
        { '@id': 'urn:AuthAccount:002', webId: 'https://pods.example/bob', username: 'bob' }
      ],
      nextCursor: 'urn:AuthAccount:002'
    }));
    context.reconcileAccount = jest.fn(async () => ({ activitiesScanned: 1, handoffsRequeued: 1, failures: 0 }));

    const result = await service.actions.run.handler.call(context, { call: jest.fn() });

    expect(context.listAccountPage).toHaveBeenCalledWith(expect.anything(), { cursor: null, limit: 2 });
    expect(context.reconcileAccount).toHaveBeenCalledTimes(2);
    expect(context.setAccountCursor).toHaveBeenCalledWith('urn:AuthAccount:002');
    expect(context.releaseDistributedLease).toHaveBeenCalledWith('lease-token');
    expect(result).toEqual({
      accountsScanned: 2,
      activitiesScanned: 2,
      handoffsRequeued: 2,
      failures: 0,
      nextAccountOffset: 0,
      nextAccountCursor: 'urn:AuthAccount:002'
    });
  });

  test('run wraps a persisted keyset cursor when it reaches the end of the account table', async () => {
    const context = createServiceContext({ accountBatchSize: 2 });
    context.getAccountCursor = jest.fn(async () => 'urn:AuthAccount:010');
    context.reconcileAccount = jest.fn(async () => ({ activitiesScanned: 0, handoffsRequeued: 0, failures: 0 }));
    context.listAccountPage = jest
      .fn()
      .mockResolvedValueOnce({ accounts: [], nextCursor: 'urn:AuthAccount:010' })
      .mockResolvedValueOnce({
        accounts: [{ '@id': 'urn:AuthAccount:001', webId: 'https://pods.example/alice', username: 'alice' }],
        nextCursor: 'urn:AuthAccount:001'
      });
    const ctx = { call: jest.fn() };

    const result = await service.actions.run.handler.call(context, ctx);

    expect(context.listAccountPage).toHaveBeenNthCalledWith(1, ctx, { cursor: 'urn:AuthAccount:010', limit: 2 });
    expect(context.listAccountPage).toHaveBeenNthCalledWith(2, ctx, { cursor: null, limit: 2 });
    expect(context.setAccountCursor).toHaveBeenCalledWith(null);
    expect(context.releaseDistributedLease).toHaveBeenCalledWith('lease-token');
    expect(result.nextAccountOffset).toBe(0);
    expect(result.nextAccountCursor).toBeNull();
  });
});
