'use strict';

const {
  REMOTE_DELIVERY_PLANNED_EVENT,
  SEMAPPS_INTERNAL_PATHS,
  SUPPORTED_SEMAPPS_ACTIVITYPUB_VERSION,
  assertExternalDeliveryConfiguration,
  assertSupportedSemappsVersion,
  createActivityPubServiceWithDeliveryStrategy,
  createOutboxPostHandler,
  normalizeRemoteDeliveryMode,
  resolveSemappsInternalPaths
} = require('../lib/activitypub-service-with-delivery-strategy');

const semappsActivityPubPackage = require('@semapps/activitypub/package.json');

function createFakeInternals() {
  const service = name => ({ name });
  return {
    ActorService: service('activitypub.actor'),
    ActivityService: service('activitypub.activity'),
    ApiService: service('activitypub.api'),
    CollectionService: service('activitypub.collection'),
    FollowService: service('activitypub.follow'),
    InboxService: service('activitypub.inbox'),
    LikeService: service('activitypub.like'),
    ObjectService: service('activitypub.object'),
    OutboxService: {
      name: 'activitypub.outbox',
      actions: {
        async post() {
          return { id: 'https://pods.example/as/activity/fake' };
        }
      }
    },
    CollectionsRegistryService: service('activitypub.collections-registry'),
    ReplyService: service('activitypub.reply'),
    ShareService: service('activitypub.share'),
    SideEffectsService: service('activitypub.side-effects'),
    FakeQueueMixin: {}
  };
}

function externalSettings(overrides = {}) {
  return {
    remoteDeliveryMode: 'external',
    allowExternalDeliveryPreview: true,
    podProvider: true,
    queueServiceUrl: 'redis://queue.example:6379',
    deliveryHandoffUrl: 'http://fedify-sidecar:8080/webhook/outbox',
    deliveryHandoffToken: 'secret',
    deliveryHandoffTimeoutMs: 1000,
    ...overrides
  };
}

function createStubPlan(activity, localRecipientUris = [], remoteRecipientUris = []) {
  return {
    schema: 'ap.delivery-plan.v1',
    intentId: `intent-${activity.id}`,
    activityId: activity.id,
    actorUri: activity.actor || 'https://pods.example/alice',
    activity,
    localRecipients: localRecipientUris.map((actorUri, index) => ({
      actorUri,
      dataset: `local-${index}`,
      inboxUri: `${actorUri}/inbox`
    })),
    remoteRecipients: remoteRecipientUris.map(actorUri => ({
      actorUri,
      inboxUrl: `${actorUri}/inbox`,
      targetDomain: new URL(actorUri).hostname
    })),
    meta: { visibility: 'direct', isPublicActivity: false }
  };
}

describe('APDM Phase 2-4 ActivityPub remote delivery strategy', () => {
  test('pins the adapter and internal paths to SemApps ActivityPub 1.1.4', () => {
    expect(semappsActivityPubPackage.version).toBe(SUPPORTED_SEMAPPS_ACTIVITYPUB_VERSION);
    expect(() => assertSupportedSemappsVersion()).not.toThrow();
    const resolved = resolveSemappsInternalPaths();
    expect(Object.keys(resolved).sort()).toEqual(Object.keys(SEMAPPS_INTERNAL_PATHS).sort());
  });

  test('normalizes valid modes and rejects unknown modes', () => {
    expect(normalizeRemoteDeliveryMode(undefined)).toBe('native');
    expect(normalizeRemoteDeliveryMode(' NATIVE ')).toBe('native');
    expect(normalizeRemoteDeliveryMode('external')).toBe('external');
    expect(() => normalizeRemoteDeliveryMode('sidecar-ish')).toThrow(/Unsupported ActivityPub remote delivery mode/u);
  });

  test('external configuration fails fast without preview guard, durable queue, handoff URL, or token', () => {
    expect(() => assertExternalDeliveryConfiguration(externalSettings({ allowExternalDeliveryPreview: false }))).toThrow(
      /explicit APDM preview guard/u
    );
    expect(() => assertExternalDeliveryConfiguration(externalSettings({ queueServiceUrl: null }))).toThrow(
      /FakeQueueMixin is forbidden/u
    );
    expect(() => assertExternalDeliveryConfiguration(externalSettings({ deliveryHandoffUrl: '' }))).toThrow(
      /handoff URL/u
    );
    expect(() => assertExternalDeliveryConfiguration(externalSettings({ deliveryHandoffUrl: 'ftp://sidecar/outbox' }))).toThrow(
      /credential-free HTTP\(S\)/u
    );
    expect(() => assertExternalDeliveryConfiguration(externalSettings({ deliveryHandoffToken: '' }))).toThrow(
      /SIDECAR_TOKEN/u
    );
    expect(() => assertExternalDeliveryConfiguration(externalSettings())).not.toThrow();
    expect(() => assertExternalDeliveryConfiguration({ remoteDeliveryMode: 'native' })).not.toThrow();
  });

  test('native mode remains unchanged and never plans or enqueues APDM handoff', async () => {
    const nativeHandler = jest.fn(async function nativePost() {
      this.createJob('remotePost', 'remote-1', {
        recipientUri: 'https://remote.example/users/bob',
        activity: { id: 'https://pods.example/as/activity/1' }
      });
      return { id: 'https://pods.example/as/activity/1' };
    });
    const buildDeliveryPlan = jest.fn();
    const enqueueHandoff = jest.fn();
    const wrapped = createOutboxPostHandler(nativeHandler, { buildDeliveryPlan, enqueueHandoff });
    const createJob = jest.fn();
    const service = {
      settings: { remoteDeliveryMode: 'native', allowExternalDeliveryPreview: false },
      createJob,
      broker: { emit: jest.fn() }
    };

    await expect(wrapped.call(service, {})).resolves.toEqual({ id: 'https://pods.example/as/activity/1' });
    expect(createJob).toHaveBeenCalledWith('remotePost', 'remote-1', expect.any(Object));
    expect(buildDeliveryPlan).not.toHaveBeenCalled();
    expect(enqueueHandoff).not.toHaveBeenCalled();
  });

  test('external preview captures SemApps partition, suppresses remotePost, then durably enqueues the plan', async () => {
    const activity = { id: 'https://pods.example/as/activity/2', actor: 'https://pods.example/alice' };
    const nativeLocalPost = jest.fn(async () => undefined);
    const nativeHandler = async function nativePost() {
      this.createJob('remotePost', 'https://remote.example/users/bob', { recipientUri: 'https://remote.example/users/bob', activity });
      this.createJob('remotePost', 'https://remote.example/users/carol', { recipientUri: 'https://remote.example/users/carol', activity });
      this.createJob('maintenance', 'keep-me', { reason: 'not-remote-delivery' });
      this.localPost(['https://pods.example/bob', 'https://pods.example/dan'], activity);
      return activity;
    };
    const plan = createStubPlan(
      activity,
      ['https://pods.example/bob', 'https://pods.example/dan'],
      ['https://remote.example/users/bob', 'https://remote.example/users/carol']
    );
    const buildDeliveryPlan = jest.fn(async () => plan);
    const enqueueHandoff = jest.fn(async () => plan.intentId);
    const wrapped = createOutboxPostHandler(nativeHandler, { buildDeliveryPlan, enqueueHandoff });
    const createJob = jest.fn();
    const broker = { emit: jest.fn() };
    const service = {
      settings: externalSettings(),
      createJob,
      localPost: nativeLocalPost,
      broker
    };

    await expect(wrapped.call(service, { requestId: 'ctx-1' })).resolves.toBe(activity);

    expect(createJob).toHaveBeenCalledTimes(1);
    expect(createJob).toHaveBeenCalledWith('maintenance', 'keep-me', { reason: 'not-remote-delivery' }, undefined);
    expect(createJob.mock.calls.some(([queueName]) => queueName === 'remotePost')).toBe(false);
    expect(nativeLocalPost).toHaveBeenCalledTimes(1);
    expect(buildDeliveryPlan).toHaveBeenCalledWith(
      { requestId: 'ctx-1' },
      expect.objectContaining({
        activity,
        localRecipientUris: ['https://pods.example/bob', 'https://pods.example/dan'],
        remoteRecipientUris: ['https://remote.example/users/bob', 'https://remote.example/users/carol'],
        podProvider: true
      })
    );
    expect(enqueueHandoff).toHaveBeenCalledWith(service, plan);
    expect(broker.emit).toHaveBeenCalledWith(
      REMOTE_DELIVERY_PLANNED_EVENT,
      expect.objectContaining({ deliveryPlan: plan, durableHandoffQueued: true }),
      { meta: { webId: null } }
    );
    expect(REMOTE_DELIVERY_PLANNED_EVENT).toBe('activitypub.outbox.remote-delivery.handoff-queued');
  });

  test('does not return until durable handoff insertion resolves', async () => {
    const activity = { id: 'https://pods.example/as/activity/block', actor: 'https://pods.example/alice' };
    let release;
    const insertion = new Promise(resolve => {
      release = resolve;
    });
    const enqueueHandoff = jest.fn(() => insertion);
    const wrapped = createOutboxPostHandler(async () => activity, {
      buildDeliveryPlan: async () => createStubPlan(activity),
      enqueueHandoff
    });
    const service = {
      settings: externalSettings(),
      createJob: jest.fn(),
      broker: { emit: jest.fn() }
    };

    let settled = false;
    const pending = wrapped.call(service, {}).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(service.broker.emit).not.toHaveBeenCalled();

    release('ok');
    await expect(pending).resolves.toBe(activity);
    expect(settled).toBe(true);
  });

  test('queue insertion failure fails the outbox action and emits no handoff-queued observation', async () => {
    const activity = { id: 'https://pods.example/as/activity/queue-fail', actor: 'https://pods.example/alice' };
    const wrapped = createOutboxPostHandler(async () => activity, {
      buildDeliveryPlan: async () => createStubPlan(activity),
      enqueueHandoff: async () => {
        throw new Error('redis unavailable');
      }
    });
    const service = {
      settings: externalSettings(),
      createJob: jest.fn(),
      broker: { emit: jest.fn() }
    };

    await expect(wrapped.call(service, {})).rejects.toThrow(/redis unavailable/u);
    expect(service.broker.emit).not.toHaveBeenCalled();
  });

  test('external mode fails before invoking native outbox when required durability config is absent', async () => {
    const nativeHandler = jest.fn();
    const wrapped = createOutboxPostHandler(nativeHandler, {
      buildDeliveryPlan: jest.fn(),
      enqueueHandoff: jest.fn()
    });
    const service = {
      settings: externalSettings({ queueServiceUrl: null }),
      createJob: jest.fn(),
      broker: { emit: jest.fn() }
    };

    await expect(wrapped.call(service, {})).rejects.toThrow(/FakeQueueMixin is forbidden/u);
    expect(nativeHandler).not.toHaveBeenCalled();
  });

  test('concurrent external requests keep interception and durable handoff request-local', async () => {
    let releaseFirst;
    const barrier = new Promise(resolve => {
      releaseFirst = resolve;
    });
    let enteredFirst;
    const entered = new Promise(resolve => {
      enteredFirst = resolve;
    });
    const nativeHandler = async function nativePost(ctx) {
      const activity = { id: ctx.activityId, actor: 'https://pods.example/alice' };
      this.createJob('remotePost', ctx.recipient, {
        recipientUri: ctx.recipient,
        activity
      });
      this.localPost([ctx.localRecipient], activity);
      if (ctx.wait) {
        enteredFirst();
        await barrier;
      }
      return activity;
    };
    const buildDeliveryPlan = jest.fn(async (_ctx, input) =>
      createStubPlan(input.activity, input.localRecipientUris, input.remoteRecipientUris)
    );
    const enqueueHandoff = jest.fn(async (_service, plan) => plan.intentId);
    const wrapped = createOutboxPostHandler(nativeHandler, { buildDeliveryPlan, enqueueHandoff });
    const originalCreateJob = jest.fn();
    const originalLocalPost = jest.fn(async () => undefined);
    const service = {
      settings: externalSettings(),
      createJob: originalCreateJob,
      localPost: originalLocalPost,
      broker: { emit: jest.fn() }
    };

    const first = wrapped.call(service, {
      recipient: 'https://one.example/users/a',
      localRecipient: 'https://pods.example/a',
      activityId: 'https://pods.example/as/activity/a',
      wait: true
    });
    await entered;
    const second = wrapped.call(service, {
      recipient: 'https://two.example/users/b',
      localRecipient: 'https://pods.example/b',
      activityId: 'https://pods.example/as/activity/b',
      wait: false
    });

    expect(service.createJob).toBe(originalCreateJob);
    expect(service.localPost).toBe(originalLocalPost);
    releaseFirst();
    await Promise.all([first, second]);
    expect(originalCreateJob).not.toHaveBeenCalled();
    expect(originalLocalPost).toHaveBeenCalledTimes(2);
    expect(enqueueHandoff).toHaveBeenCalledTimes(2);
  });

  test('factory registers exactly one strategy-aware outbox with durable handoff queue and internal enqueue action', () => {
    const serviceSchema = createActivityPubServiceWithDeliveryStrategy({
      remoteDeliveryMode: 'external',
      allowExternalDeliveryPreview: true,
      settings: {
        baseUri: 'https://pods.example',
        podProvider: true,
        queueServiceUrl: 'redis://queue.example:6379',
        deliveryHandoffUrl: 'http://sidecar/webhook/outbox',
        deliveryHandoffToken: 'secret'
      },
      internals: createFakeInternals(),
      buildDeliveryPlan: jest.fn(),
      enqueueHandoff: jest.fn()
    });
    const registered = [];
    serviceSchema.created.call({
      settings: serviceSchema.settings,
      broker: { createService(schema) { registered.push(schema); } }
    });

    const outbox = registered.find(schema =>
      Array.isArray(schema.mixins) && schema.mixins.some(mixin => mixin?.name === 'activitypub.outbox')
    );
    expect(outbox).toBeDefined();
    expect(outbox.settings).toEqual(expect.objectContaining({ remoteDeliveryMode: 'external' }));
    expect(outbox.queues.deliveryHandoff).toEqual(expect.objectContaining({ name: '*' }));
    expect(typeof outbox.queues.deliveryHandoff.process).toBe('function');
    expect(typeof outbox.actions.enqueueDeliveryHandoff.handler).toBe('function');
  });
});