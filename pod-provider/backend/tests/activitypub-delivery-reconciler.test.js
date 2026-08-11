'use strict';

const service = require('../services/activitypub-delivery-reconciler.service');

function createServiceContext(overrides = {}) {
  let accountOffset = 0;
  return {
    settings: {
      enabled: true,
      baseUri: 'https://pods.example',
      intervalMs: 60000,
      lookbackMs: 900000,
      accountBatchSize: 100,
      maxActivitiesPerAccount: 50,
      concurrency: 2,
      ...overrides
    },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    reconcileAccount: service.methods.reconcileAccount,
    reconcileActivity: service.methods.reconcileActivity,
    expandConcreteRecipients: service.methods.expandConcreteRecipients,
    acquireDistributedLease: jest.fn(async () => 'lease-token'),
    releaseDistributedLease: jest.fn(async () => true),
    getAccountOffset: jest.fn(async () => accountOffset),
    setAccountOffset: jest.fn(async next => {
      accountOffset = next;
    }),
    reconciliationRunning: false,
    reconciliationStats: {
      runs: 0,
      accountsScanned: 0,
      activitiesScanned: 0,
      handoffsRequeued: 0,
      failures: 0,
      accountOffset: 0,
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
          expect(params.query).toContain('LIMIT 50');
          expect(params.query).toContain('OFFSET 0');
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
          return { webId: params.webId, username: 'bob' };
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
    const offsets = [];
    const ctx = {
      async call(action, params) {
        if (action === 'activitypub.actor.getCollectionUri') return 'https://pods.example/alice/outbox';
        if (action === 'triplestore.query') {
          const match = params.query.match(/OFFSET (\d+)/u);
          const offset = Number(match?.[1] || 0);
          offsets.push(offset);
          const page = activities.slice(offset, offset + 2);
          return page.map(activity => ({
            activityUri: { value: activity.id },
            published: { value: activity.published }
          }));
        }
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

    expect(offsets).toEqual([0, 2]);
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

  test('run filters tombstones, advances the durable account cursor, and releases its lease', async () => {
    const context = createServiceContext({ accountBatchSize: 2 });
    context.reconcileAccount = jest.fn(async () => ({ activitiesScanned: 1, handoffsRequeued: 1, failures: 0 }));
    const ctx = {
      call: jest.fn(async (action, params) => {
        if (action === 'auth.account.find') {
          expect(params).toEqual({ limit: 2, offset: 0 });
          return [
            { webId: 'https://pods.example/alice', username: 'alice' },
            { webId: 'https://pods.example/deleted', username: 'deleted', deletedAt: new Date().toISOString() }
          ];
        }
        throw new Error(`Unexpected call ${action}`);
      })
    };

    const result = await service.actions.run.handler.call(context, ctx);

    expect(context.reconcileAccount).toHaveBeenCalledTimes(1);
    expect(context.setAccountOffset).toHaveBeenCalledWith(2);
    expect(context.releaseDistributedLease).toHaveBeenCalledWith('lease-token');
    expect(result).toEqual({
      accountsScanned: 1,
      activitiesScanned: 1,
      handoffsRequeued: 1,
      failures: 0,
      nextAccountOffset: 2
    });
  });

  test('run wraps a persisted cursor when it reaches the end of the account table', async () => {
    const context = createServiceContext({ accountBatchSize: 2 });
    context.getAccountOffset = jest.fn(async () => 10);
    context.reconcileAccount = jest.fn(async () => ({ activitiesScanned: 0, handoffsRequeued: 0, failures: 0 }));
    const calls = [];
    const ctx = {
      async call(action, params) {
        if (action !== 'auth.account.find') throw new Error(`Unexpected call ${action}`);
        calls.push(params);
        if (params.offset === 10) return [];
        return [{ webId: 'https://pods.example/alice', username: 'alice' }];
      }
    };

    const result = await service.actions.run.handler.call(context, ctx);

    expect(calls).toEqual([{ limit: 2, offset: 10 }, { limit: 2, offset: 0 }]);
    expect(context.setAccountOffset).toHaveBeenCalledWith(0);
    expect(context.releaseDistributedLease).toHaveBeenCalledWith('lease-token');
    expect(result.nextAccountOffset).toBe(0);
  });
});