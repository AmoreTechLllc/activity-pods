'use strict';

const {
  createActivityPubServiceWithDeliveryStrategy,
  normalizeRemoteDeliveryMode
} = require('../lib/activitypub-service-with-delivery-strategy');

function fakeInternals() {
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
    OutboxService: { name: 'activitypub.outbox', actions: { async post() {} } },
    CollectionsRegistryService: service('activitypub.collections-registry'),
    ReplyService: service('activitypub.reply'),
    ShareService: service('activitypub.share'),
    SideEffectsService: service('activitypub.side-effects'),
    FakeQueueMixin: {}
  };
}

describe('APDM Phase 2 ambiguous configuration hardening', () => {
  test('only nullish delivery-mode values default to native', () => {
    expect(normalizeRemoteDeliveryMode(undefined)).toBe('native');
    expect(normalizeRemoteDeliveryMode(null)).toBe('native');
    expect(() => normalizeRemoteDeliveryMode('')).toThrow(/Unsupported ActivityPub remote delivery mode/u);
    expect(() => normalizeRemoteDeliveryMode('   ')).toThrow(/Unsupported ActivityPub remote delivery mode/u);
  });

  test('factory rejects non-boolean preview guard values instead of truthy coercion', () => {
    expect(() => createActivityPubServiceWithDeliveryStrategy({
      remoteDeliveryMode: 'native',
      allowExternalDeliveryPreview: 'false',
      internals: fakeInternals()
    })).toThrow(/preview guard must be a boolean/u);
  });
});
