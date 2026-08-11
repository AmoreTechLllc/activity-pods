'use strict';

const {
  SEMAPPS_OUTBOX_INTERCEPTION_MARKERS,
  assertExternalDeliveryConfiguration,
  assertSupportedSemappsOutboxShape,
  createOutboxPostHandler,
  validateCapturedLocalPosts,
  validateCapturedRemotePosts
} = require('../lib/activitypub-service-with-delivery-strategy');

function activity(id = 'https://pods.example/as/activity/hardening') {
  return { id, actor: 'https://pods.example/alice', type: 'Create' };
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

function createCompatibleOutboxShape() {
  const post = new Function(
    'ctx',
    `return (async function () {
      await ctx.call('activitypub.activity.getRecipients', { activity: {} });
      this.createJob('remotePost', 'https://remote.example/users/a', {}, {});
      ctx.emit('activitypub.outbox.posted', { activity: {} });
      this.localPost(localRecipients, activity);
    }).call(this);`
  );
  return {
    actions: { post },
    methods: { localPost() {} },
    queues: { remotePost: { async process() {} } }
  };
}

describe('APDM Phase 2 interception hardening', () => {
  test('documents and enforces the critical SemApps interception ordering', () => {
    expect(SEMAPPS_OUTBOX_INTERCEPTION_MARKERS).toEqual([
      'activitypub.activity.getRecipients',
      "this.createJob('remotePost'",
      'activitypub.outbox.posted',
      'this.localPost(localRecipients, activity)'
    ]);
    expect(() => assertSupportedSemappsOutboxShape(createCompatibleOutboxShape())).not.toThrow();

    const incompatible = createCompatibleOutboxShape();
    incompatible.actions.post = function post(ctx) {
      this.localPost([], {});
      ctx.emit('activitypub.outbox.posted', { activity: {} });
      this.createJob('remotePost', 'x', {}, {});
      return ctx.call('activitypub.activity.getRecipients', { activity: {} });
    };
    expect(() => assertSupportedSemappsOutboxShape(incompatible)).toThrow(/incompatible SemApps outbox ordering/u);
  });

  test('suppressed remotePost jobs fail closed when recipient identity is missing or unsafe', () => {
    const expected = activity();
    expect(() => validateCapturedRemotePosts([
      { jobId: 'bad', recipientUri: undefined, activity: expected }
    ], expected)).toThrow(/safe concrete HTTP\(S\) recipientUri/u);

    expect(() => validateCapturedRemotePosts([
      {
        jobId: 'https://user:pass@remote.example/users/a',
        recipientUri: 'https://user:pass@remote.example/users/a',
        activity: expected
      }
    ], expected)).toThrow(/safe concrete HTTP\(S\) recipientUri/u);
  });

  test('suppressed remotePost jobs fail closed when their Activity differs from the returned Activity', () => {
    const expected = activity();
    expect(() => validateCapturedRemotePosts([
      {
        jobId: 'https://remote.example/users/a',
        recipientUri: 'https://remote.example/users/a',
        activity: activity('https://pods.example/as/activity/other')
      }
    ], expected)).toThrow(/does not match the outbox result/u);
  });

  test('captured localPost calls accumulate recipients across calls and validate Activity identity', () => {
    const expected = activity();
    expect(validateCapturedLocalPosts([
      { recipients: ['https://pods.example/bob'], activity: expected },
      { recipients: ['https://pods.example/carol', 'https://pods.example/bob'], activity: expected }
    ], expected)).toEqual(['https://pods.example/bob', 'https://pods.example/carol']);

    expect(() => validateCapturedLocalPosts([
      { recipients: ['https://pods.example/bob'], activity: activity('https://pods.example/as/activity/other') }
    ], expected)).toThrow(/does not match the outbox result/u);
  });

  test('wrapper never plans or enqueues after a malformed suppressed remotePost job', async () => {
    const expected = activity();
    const buildDeliveryPlan = jest.fn();
    const enqueueHandoff = jest.fn();
    const wrapped = createOutboxPostHandler(async function nativePost() {
      this.createJob('remotePost', 'malformed', { activity: expected });
      return expected;
    }, { buildDeliveryPlan, enqueueHandoff });
    const service = {
      settings: externalSettings(),
      createJob: jest.fn(),
      localPost: jest.fn(),
      broker: { emit: jest.fn() }
    };

    await expect(wrapped.call(service, {})).rejects.toThrow(/safe concrete HTTP\(S\) recipientUri/u);
    expect(buildDeliveryPlan).not.toHaveBeenCalled();
    expect(enqueueHandoff).not.toHaveBeenCalled();
    expect(service.broker.emit).not.toHaveBeenCalled();
  });

  test('wrapper accumulates more than one localPost observation without mutating the shared method', async () => {
    const expected = activity();
    const plan = { intentId: 'plan' };
    const buildDeliveryPlan = jest.fn(async () => plan);
    const enqueueHandoff = jest.fn(async () => 'plan');
    const nativeLocalPost = jest.fn(async () => undefined);
    const wrapped = createOutboxPostHandler(async function nativePost() {
      this.localPost(['https://pods.example/bob'], expected);
      this.localPost(['https://pods.example/carol'], expected);
      return expected;
    }, { buildDeliveryPlan, enqueueHandoff });
    const service = {
      settings: externalSettings(),
      createJob: jest.fn(),
      localPost: nativeLocalPost,
      broker: { emit: jest.fn() }
    };

    await wrapped.call(service, {});
    expect(service.localPost).toBe(nativeLocalPost);
    expect(nativeLocalPost).toHaveBeenCalledTimes(2);
    expect(buildDeliveryPlan).toHaveBeenCalledWith({}, expect.objectContaining({
      localRecipientUris: ['https://pods.example/bob', 'https://pods.example/carol']
    }));
  });

  test('external configuration rejects credentials, fragments, blank tokens and unsafe timeouts', () => {
    expect(() => assertExternalDeliveryConfiguration(externalSettings({
      deliveryHandoffUrl: 'http://user:pass@fedify-sidecar:8080/webhook/outbox'
    }))).toThrow(/credential-free HTTP\(S\)/u);
    expect(() => assertExternalDeliveryConfiguration(externalSettings({
      deliveryHandoffUrl: 'http://fedify-sidecar:8080/webhook/outbox#fragment'
    }))).toThrow(/must not contain a URL fragment/u);
    expect(() => assertExternalDeliveryConfiguration(externalSettings({ deliveryHandoffToken: '   ' }))).toThrow(/SIDECAR_TOKEN/u);
    expect(() => assertExternalDeliveryConfiguration(externalSettings({ deliveryHandoffTimeoutMs: 0 }))).toThrow(/between 100 and 60000/u);
    expect(() => assertExternalDeliveryConfiguration(externalSettings({ deliveryHandoffTimeoutMs: Infinity }))).toThrow(/between 100 and 60000/u);
    expect(() => assertExternalDeliveryConfiguration(externalSettings({ deliveryHandoffTimeoutMs: 60001 }))).toThrow(/between 100 and 60000/u);
  });
});
