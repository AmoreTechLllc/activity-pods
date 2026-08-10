'use strict';

const QueueMixin = require('moleculer-bull');
const { as, sec } = require('@semapps/ontologies');
const semappsActivityPubPackage = require('@semapps/activitypub/package.json');
const { buildDeliveryPlanV1 } = require('../utils/activitypub-delivery-planner');
const {
  DELIVERY_HANDOFF_QUEUE,
  enqueueDeliveryHandoff,
  processDeliveryHandoffJob
} = require('../utils/activitypub-delivery-handoff');

const SUPPORTED_SEMAPPS_ACTIVITYPUB_VERSION = '1.1.4';
const REMOTE_DELIVERY_MODES = new Set(['native', 'external']);
// P4 event is observation-only. outbox-emitter intentionally listens to the
// former P3 planned event name, so this cannot create a second sidecar HTTP path.
const REMOTE_DELIVERY_PLANNED_EVENT = 'activitypub.outbox.remote-delivery.handoff-queued';
const SEMAPPS_INTERNAL_PATHS = Object.freeze({
  ActorService: '@semapps/activitypub/services/activitypub/subservices/actor',
  ActivityService: '@semapps/activitypub/services/activitypub/subservices/activity',
  ApiService: '@semapps/activitypub/services/activitypub/subservices/api',
  CollectionService: '@semapps/activitypub/services/activitypub/subservices/collection',
  FollowService: '@semapps/activitypub/services/activitypub/subservices/follow',
  InboxService: '@semapps/activitypub/services/activitypub/subservices/inbox',
  LikeService: '@semapps/activitypub/services/activitypub/subservices/like',
  ObjectService: '@semapps/activitypub/services/activitypub/subservices/object',
  OutboxService: '@semapps/activitypub/services/activitypub/subservices/outbox',
  CollectionsRegistryService: '@semapps/activitypub/services/activitypub/subservices/collections-registry',
  ReplyService: '@semapps/activitypub/services/activitypub/subservices/reply',
  ShareService: '@semapps/activitypub/services/activitypub/subservices/share',
  SideEffectsService: '@semapps/activitypub/services/activitypub/subservices/side-effects',
  FakeQueueMixin: '@semapps/activitypub/mixins/fake-queue'
});

function normalizeRemoteDeliveryMode(value) {
  const normalized = String(value || 'native').trim().toLowerCase();
  if (!REMOTE_DELIVERY_MODES.has(normalized)) {
    throw new Error(`Unsupported ActivityPub remote delivery mode '${value}'. Expected one of: native, external.`);
  }
  return normalized;
}

function assertSupportedSemappsVersion() {
  if (semappsActivityPubPackage.version !== SUPPORTED_SEMAPPS_ACTIVITYPUB_VERSION) {
    throw new Error(
      `APDM delivery strategy adapter supports @semapps/activitypub ${SUPPORTED_SEMAPPS_ACTIVITYPUB_VERSION}; ` +
        `installed version is ${semappsActivityPubPackage.version}. Review the upstream outbox implementation before upgrading.`
    );
  }
}

function resolveSemappsInternalPaths() {
  return Object.fromEntries(
    Object.entries(SEMAPPS_INTERNAL_PATHS).map(([name, modulePath]) => [name, require.resolve(modulePath)])
  );
}

function loadSemappsActivityPubInternals() {
  assertSupportedSemappsVersion();
  return Object.fromEntries(
    Object.entries(SEMAPPS_INTERNAL_PATHS).map(([name, modulePath]) => [name, require(modulePath)])
  );
}

function createOutboxPostHandler(
  nativePostHandler,
  { buildDeliveryPlan = buildDeliveryPlanV1, enqueueHandoff = enqueueDeliveryHandoff } = {}
) {
  if (typeof nativePostHandler !== 'function') {
    throw new TypeError('SemApps outbox post handler must be a function');
  }
  if (typeof buildDeliveryPlan !== 'function') {
    throw new TypeError('ActivityPub delivery plan builder must be a function');
  }
  if (typeof enqueueHandoff !== 'function') {
    throw new TypeError('ActivityPub durable handoff enqueuer must be a function');
  }

  return async function postWithRemoteDeliveryStrategy(ctx) {
    const mode = normalizeRemoteDeliveryMode(this.settings.remoteDeliveryMode);

    if (mode === 'native') {
      return nativePostHandler.call(this, ctx);
    }

    if (!this.settings.allowExternalDeliveryPreview) {
      throw new Error(
        'ActivityPub external remote delivery is not yet enabled for production. ' +
          'APDM Phase 4 adds durable handoff only; production remote-authority cutover is APDM Phase 5.'
      );
    }

    const capturedRemotePosts = [];
    let capturedLocalRecipients = [];
    const executionContext = Object.create(this);
    const nativeCreateJob = this.createJob.bind(this);
    const nativeLocalPost = typeof this.localPost === 'function' ? this.localPost.bind(this) : null;

    executionContext.createJob = (queueName, jobId, payload, options) => {
      if (queueName === 'remotePost') {
        capturedRemotePosts.push({
          jobId,
          recipientUri: payload && payload.recipientUri,
          activity: payload && payload.activity,
          options
        });
        return undefined;
      }
      return nativeCreateJob(queueName, jobId, payload, options);
    };

    if (nativeLocalPost) {
      executionContext.localPost = (recipients, activity) => {
        capturedLocalRecipients = Array.isArray(recipients) ? [...recipients] : [];
        return nativeLocalPost(recipients, activity);
      };
    }

    const activity = await nativePostHandler.call(executionContext, ctx);
    const remoteRecipientUris = [
      ...new Set(capturedRemotePosts.map(job => job.recipientUri).filter(recipientUri => typeof recipientUri === 'string'))
    ];
    const localRecipientUris = [...new Set(capturedLocalRecipients.filter(recipientUri => typeof recipientUri === 'string'))];

    const deliveryPlan = await buildDeliveryPlan(ctx, {
      activity,
      localRecipientUris,
      remoteRecipientUris,
      podProvider: this.settings.podProvider
    });

    // P4 durability boundary: do not return from the outbox action until Bull
    // confirms the handoff retry job has been inserted in the configured queue.
    await enqueueHandoff(this, deliveryPlan);

    // Observation only. There is deliberately no listener that performs HTTP
    // delivery for this event; the durable Bull handoff processor owns it.
    this.broker.emit(
      REMOTE_DELIVERY_PLANNED_EVENT,
      {
        activity,
        deliveryPlan,
        remoteRecipients: remoteRecipientUris,
        localRecipients: localRecipientUris,
        suppressedNativeRemotePostCount: capturedRemotePosts.length,
        deliveryMode: 'external',
        durableHandoffQueued: true
      },
      { meta: { webId: null } }
    );

    return activity;
  };
}

function createOutboxServiceSchema({
  baseUri,
  podProvider,
  queueServiceUrl,
  remoteDeliveryMode,
  allowExternalDeliveryPreview,
  deliveryHandoffUrl,
  deliveryHandoffToken,
  deliveryHandoffTimeoutMs,
  internals,
  buildDeliveryPlan,
  enqueueHandoff
}) {
  const { OutboxService, FakeQueueMixin } = internals;
  const queueMixin = queueServiceUrl ? QueueMixin(queueServiceUrl) : FakeQueueMixin;

  return {
    mixins: [OutboxService, queueMixin],
    settings: {
      baseUri,
      podProvider,
      queueServiceUrl,
      remoteDeliveryMode,
      allowExternalDeliveryPreview,
      deliveryHandoffUrl,
      deliveryHandoffToken,
      deliveryHandoffTimeoutMs
    },
    actions: {
      post: createOutboxPostHandler(OutboxService.actions.post, { buildDeliveryPlan, enqueueHandoff })
    },
    queues: {
      [DELIVERY_HANDOFF_QUEUE]: {
        name: '*',
        async process(job) {
          return processDeliveryHandoffJob(this, job);
        }
      }
    }
  };
}

function createActivityPubServiceWithDeliveryStrategy({
  remoteDeliveryMode = 'native',
  allowExternalDeliveryPreview = false,
  settings = {},
  internals,
  buildDeliveryPlan,
  enqueueHandoff
} = {}) {
  assertSupportedSemappsVersion();
  const normalizedRemoteDeliveryMode = normalizeRemoteDeliveryMode(remoteDeliveryMode);
  const resolvedInternals = internals || loadSemappsActivityPubInternals();

  return {
    name: 'activitypub',
    settings: {
      baseUri: null,
      podProvider: false,
      activitiesPath: '/as/activity',
      collectionsPath: '/as/collection',
      activateTombstones: true,
      selectActorData: null,
      queueServiceUrl: null,
      deliveryHandoffUrl: null,
      deliveryHandoffToken: '',
      deliveryHandoffTimeoutMs: 5000,
      ...settings,
      remoteDeliveryMode: normalizedRemoteDeliveryMode,
      allowExternalDeliveryPreview: Boolean(allowExternalDeliveryPreview)
    },
    dependencies: ['api', 'ontologies'],
    created() {
      const {
        baseUri,
        podProvider,
        activitiesPath,
        collectionsPath,
        selectActorData,
        queueServiceUrl,
        activateTombstones,
        remoteDeliveryMode: configuredRemoteDeliveryMode,
        allowExternalDeliveryPreview: configuredExternalPreview,
        deliveryHandoffUrl,
        deliveryHandoffToken,
        deliveryHandoffTimeoutMs
      } = this.settings;
      const {
        ActorService,
        ActivityService,
        ApiService,
        CollectionService,
        FollowService,
        InboxService,
        LikeService,
        ObjectService,
        CollectionsRegistryService,
        ReplyService,
        ShareService,
        SideEffectsService,
        FakeQueueMixin
      } = resolvedInternals;
      const sideEffectsQueueMixin = queueServiceUrl ? QueueMixin(queueServiceUrl) : FakeQueueMixin;

      this.broker.createService({ mixins: [SideEffectsService, sideEffectsQueueMixin], settings: { podProvider } });
      this.broker.createService({ mixins: [CollectionService], settings: { podProvider, path: collectionsPath } });
      this.broker.createService({ mixins: [CollectionsRegistryService], settings: { baseUri, podProvider } });
      this.broker.createService({ mixins: [ActorService], settings: { baseUri, selectActorData, podProvider } });
      this.broker.createService({ mixins: [ApiService], settings: { baseUri, podProvider } });
      this.broker.createService({ mixins: [ObjectService], settings: { baseUri, podProvider, activateTombstones } });
      this.broker.createService({ mixins: [ActivityService], settings: { baseUri, podProvider, path: activitiesPath } });
      this.broker.createService({ mixins: [FollowService], settings: { baseUri } });
      this.broker.createService({ mixins: [InboxService], settings: { podProvider } });
      this.broker.createService({ mixins: [LikeService], settings: { baseUri, podProvider } });
      this.broker.createService({ mixins: [ShareService], settings: { baseUri, podProvider } });
      this.broker.createService({ mixins: [ReplyService], settings: { baseUri, podProvider } });
      this.broker.createService(
        createOutboxServiceSchema({
          baseUri,
          podProvider,
          queueServiceUrl,
          remoteDeliveryMode: configuredRemoteDeliveryMode,
          allowExternalDeliveryPreview: configuredExternalPreview,
          deliveryHandoffUrl,
          deliveryHandoffToken,
          deliveryHandoffTimeoutMs,
          internals: resolvedInternals,
          buildDeliveryPlan,
          enqueueHandoff
        })
      );
    },
    async started() {
      await this.broker.call('ontologies.register', as);
      await this.broker.call('ontologies.register', sec);
    }
  };
}

module.exports = {
  REMOTE_DELIVERY_PLANNED_EVENT,
  SEMAPPS_INTERNAL_PATHS,
  SUPPORTED_SEMAPPS_ACTIVITYPUB_VERSION,
  assertSupportedSemappsVersion,
  createActivityPubServiceWithDeliveryStrategy,
  createOutboxPostHandler,
  createOutboxServiceSchema,
  loadSemappsActivityPubInternals,
  normalizeRemoteDeliveryMode,
  resolveSemappsInternalPaths
};
