'use strict';

const {
  createActivityPubServiceWithDeliveryStrategy
} = require('../lib/activitypub-service-with-delivery-strategy');

function namedService(name, extra = {}) {
  return { name, ...extra };
}

function fakeInternals() {
  return {
    ActorService: namedService('activitypub.actor'),
    ActivityService: namedService('activitypub.activity'),
    ApiService: namedService('activitypub.api'),
    CollectionService: namedService('activitypub.collection'),
    FollowService: namedService('activitypub.follow'),
    InboxService: namedService('activitypub.inbox'),
    LikeService: namedService('activitypub.like'),
    ObjectService: namedService('activitypub.object'),
    OutboxService: namedService('activitypub.outbox', {
      actions: { async post() {} }
    }),
    CollectionsRegistryService: namedService('activitypub.collections-registry'),
    ReplyService: namedService('activitypub.reply'),
    ShareService: namedService('activitypub.share'),
    SideEffectsService: namedService('activitypub.side-effects'),
    FakeQueueMixin: {}
  };
}

function primaryMixinName(schema) {
  return Array.isArray(schema.mixins)
    ? schema.mixins.map(mixin => mixin?.name).find(Boolean)
    : undefined;
}

describe('APDM Phase 2 SemApps 1.1.4 service-registration parity', () => {
  test('registers the complete upstream ActivityPub subservice set exactly once', () => {
    const serviceSchema = createActivityPubServiceWithDeliveryStrategy({
      remoteDeliveryMode: 'native',
      allowExternalDeliveryPreview: false,
      settings: {
        baseUri: 'https://pods.example',
        podProvider: true,
        queueServiceUrl: null
      },
      internals: fakeInternals(),
      buildDeliveryPlan: jest.fn(),
      enqueueHandoff: jest.fn()
    });

    const registered = [];
    serviceSchema.created.call({
      settings: serviceSchema.settings,
      broker: {
        createService(schema) {
          registered.push(schema);
        }
      }
    });

    const names = registered.map(primaryMixinName).filter(Boolean);
    expect(names).toEqual([
      'activitypub.side-effects',
      'activitypub.collection',
      'activitypub.collections-registry',
      'activitypub.actor',
      'activitypub.api',
      'activitypub.object',
      'activitypub.activity',
      'activitypub.follow',
      'activitypub.inbox',
      'activitypub.like',
      'activitypub.share',
      'activitypub.reply',
      'activitypub.outbox'
    ]);
    expect(new Set(names).size).toBe(names.length);
  });
});
