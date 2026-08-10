'use strict';

const {
  REMOTE_DELIVERY_PLANNED_EVENT,
  SEMAPPS_INTERNAL_PATHS,
  SUPPORTED_SEMAPPS_ACTIVITYPUB_VERSION,
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

describe('APDM Phase 2 ActivityPub remote delivery strategy', () => {
  test('pins the adapter to the installed SemApps ActivityPub version', () => {
    expect(semappsActivityPubPackage.version).toBe(SUPPORTED_SEMAPPS_ACTIVITYPUB_VERSION);
    expect(() => assertSupportedSemappsVersion()).not.toThrow();
  });

  test('all pinned SemApps 1.1.4 internal module paths resolve from the installed package', () => {
    const resolved = resolveSemappsInternalPaths();
    expect(Object.keys(resolved).sort()).toEqual(Object.keys(SEMAPPS_INTERNAL_PATHS).sort());
    for (const resolvedPath of Object.values(resolved)) {
      expect(typeof resolvedPath).toBe('string');
      expect(resolvedPath.length).toBeGreaterThan(0);
    }
  });

  test('normalizes valid modes and rejects unknown modes', () => {
    expect(normalizeRemoteDeliveryMode(undefined)).toBe('native');
    expect(normalizeRemoteDeliveryMode(' NATIVE ')).toBe('native');
    expect(normalizeRemoteDeliveryMode('external')).toBe('external');
    expect(() => normalizeRemoteDeliveryMode('sidecar-ish')).toThrow(/Unsupported ActivityPub remote delivery mode/u);
  });

  test('native mode delegates unchanged to the SemApps-style handler', async () => {
    const nativeHandler = jest.fn(async function nativePost() {
      this.createJob('remotePost', 'remote-1', {
        recipientUri: 'https://remote.example/users/bob',
        activity: { id: 'https://pods.example/as/activity/1' }
      });
      return { id: 'https://pods.example/as/activity/1' };
    });
    const wrapped = createOutboxPostHandler(nativeHandler);
    const createJob = jest.fn();
    const service = {
      settings: { remoteDeliveryMode: 'native', allowExternalDeliveryPreview: false },
      createJob,
      broker: { emit: jest.fn() }
    };

    const result = await wrapped.call(service, {});

    expect(result).toEqual({ id: 'https://pods.example/as/activity/1' });
    expect(nativeHandler).toHaveBeenCalledTimes(1);
    expect(createJob).toHaveBeenCalledWith(
      'remotePost',
      'remote-1',
      expect.objectContaining({ recipientUri: 'https://remote.example/users/bob' })
    );
    expect(service.broker.emit).not.toHaveBeenCalled();
  });

  test('external preview suppresses native remotePost jobs but delegates unrelated queues', async () => {
    const activity = { id: 'https://pods.example/as/activity/2' };
    const nativeHandler = async function nativePost() {
      this.createJob('remotePost', 'bob', {
        recipientUri: 'https://remote.example/users/bob',
        activity
      });
      this.createJob('remotePost', 'carol', {
        recipientUri: 'https://remote.example/users/carol',
        activity
      });
      this.createJob('maintenance', 'keep-me', { reason: 'not-remote-delivery' });
      return activity;
    };
    const wrapped = createOutboxPostHandler(nativeHandler);
    const createJob = jest.fn();
    const broker = { emit: jest.fn() };
    const service = {
      settings: { remoteDeliveryMode: 'external', allowExternalDeliveryPreview: true },
      createJob,
      broker
    };

    const result = await wrapped.call(service, {});

    expect(result).toBe(activity);
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(createJob).toHaveBeenCalledWith('maintenance', 'keep-me', { reason: 'not-remote-delivery' }, undefined);
    expect(createJob.mock.calls.some(([queueName]) => queueName === 'remotePost')).toBe(false);
    expect(broker.emit).toHaveBeenCalledWith(
      REMOTE_DELIVERY_PLANNED_EVENT,
      {
        activity,
        remoteRecipients: [
          'https://remote.example/users/bob',
          'https://remote.example/users/carol'
        ],
        suppressedNativeRemotePostCount: 2,
        deliveryMode: 'external'
      },
      { meta: { webId: null } }
    );
  });

  test('external mode fails closed unless the explicit preview guard is enabled', async () => {
    const nativeHandler = jest.fn();
    const wrapped = createOutboxPostHandler(nativeHandler);
    const service = {
      settings: { remoteDeliveryMode: 'external', allowExternalDeliveryPreview: false },
      createJob: jest.fn(),
      broker: { emit: jest.fn() }
    };

    await expect(wrapped.call(service, {})).rejects.toThrow(/not yet enabled for production/u);
    expect(nativeHandler).not.toHaveBeenCalled();
  });

  test('does not mutate the shared service createJob function in external mode', async () => {
    let releaseFirst;
    const firstBarrier = new Promise(resolve => {
      releaseFirst = resolve;
    });
    let firstEntered;
    const firstEnteredPromise = new Promise(resolve => {
      firstEntered = resolve;
    });

    const nativeHandler = async function nativePost(ctx) {
      this.createJob('remotePost', ctx.recipient, {
        recipientUri: ctx.recipient,
        activity: { id: ctx.activityId }
      });
      if (ctx.wait) {
        firstEntered();
        await firstBarrier;
      }
      return { id: ctx.activityId };
    };

    const wrapped = createOutboxPostHandler(nativeHandler);
    const originalCreateJob = jest.fn();
    const broker = { emit: jest.fn() };
    const service = {
      settings: { remoteDeliveryMode: 'external', allowExternalDeliveryPreview: true },
      createJob: originalCreateJob,
      broker
    };

    const first = wrapped.call(service, {
      recipient: 'https://one.example/users/a',
      activityId: 'https://pods.example/as/activity/a',
      wait: true
    });
    await firstEnteredPromise;

    const second = wrapped.call(service, {
      recipient: 'https://two.example/users/b',
      activityId: 'https://pods.example/as/activity/b',
      wait: false
    });

    expect(service.createJob).toBe(originalCreateJob);
    releaseFirst();
    await Promise.all([first, second]);

    expect(originalCreateJob).not.toHaveBeenCalled();
    const plannedEvents = broker.emit.mock.calls.filter(([eventName]) => eventName === REMOTE_DELIVERY_PLANNED_EVENT);
    expect(plannedEvents).toHaveLength(2);
    expect(plannedEvents.map(([, payload]) => payload.remoteRecipients)).toEqual(
      expect.arrayContaining([
        ['https://one.example/users/a'],
        ['https://two.example/users/b']
      ])
    );
  });

  test('the ActivityPub service factory registers exactly one strategy-aware outbox service', () => {
    const serviceSchema = createActivityPubServiceWithDeliveryStrategy({
      remoteDeliveryMode: 'external',
      allowExternalDeliveryPreview: true,
      settings: {
        baseUri: 'https://pods.example',
        podProvider: true,
        queueServiceUrl: null
      },
      internals: createFakeInternals()
    });
    const registered = [];
    const serviceContext = {
      settings: serviceSchema.settings,
      broker: {
        createService(schema) {
          registered.push(schema);
        }
      }
    };

    serviceSchema.created.call(serviceContext);

    const outboxes = registered.filter(schema =>
      Array.isArray(schema.mixins) && schema.mixins.some(mixin => mixin && mixin.name === 'activitypub.outbox')
    );
    expect(outboxes).toHaveLength(1);
    expect(outboxes[0].settings).toEqual(
      expect.objectContaining({
        baseUri: 'https://pods.example',
        podProvider: true,
        remoteDeliveryMode: 'external',
        allowExternalDeliveryPreview: true
      })
    );
    expect(typeof outboxes[0].actions.post).toBe('function');
  });
});
