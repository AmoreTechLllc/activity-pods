/**
 * ActivityPods Outbox Event Emitter Service
 */
'use strict';

const { ulid } = require('ulid');
const { retryWithBackoff } = require('../utils/backoff');
const { validateDeliveryPlanV1 } = require('../utils/activitypub-delivery-plan');
const { resolvePublicSearchConsent } = require('../utils/search-consent');
const { extractHashtagsFromText } = require('../utils/hashtags');
const { resolvePhase6ObservationConfig } = require('../lib/activitypub-phase6-observation-config');

const observationConfig = resolvePhase6ObservationConfig({
  remoteDeliveryMode: process.env.SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE || 'native',
  sidecarObservationWebhookUrl:
    process.env.SIDECAR_OBSERVATION_WEBHOOK_URL || 'http://fedify-sidecar:8080/webhook/outbox-observation',
  // Unit suites load this service without deployment secrets. The synthetic
  // test-only value never escapes NODE_ENV=test; production native mode still
  // fails closed if SIDECAR_TOKEN is absent.
  sidecarToken: process.env.SIDECAR_TOKEN || (process.env.NODE_ENV === 'test' ? 'apdm-test-sidecar-token' : ''),
  observationWebhookRetries: process.env.OBSERVATION_WEBHOOK_RETRIES,
  observationWebhookTimeoutMs: process.env.OBSERVATION_WEBHOOK_TIMEOUT_MS
});

module.exports = {
  name: 'outbox-emitter',
  dependencies: ['activitypub.outbox'],
  settings: observationConfig,
  events: {
    'activitypub.outbox.posted': {
      async handler(ctx) {
        if (this.settings.remoteDeliveryMode === 'external') {
          this.logger.debug('Ignoring raw outbox.posted routing event in APDM external mode');
          return;
        }
        const { activity } = ctx.params;
        const actorUri = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id || null;
        const visibility = this.determineVisibility(activity);
        const isPublicActivity = visibility === 'public' || visibility === 'unlisted';
        const searchConsent = await this.buildSearchConsent(ctx, activity, actorUri);
        const event = await this.buildCommittedEvent(ctx, {
          activity,
          actorUri,
          deliveryTargets: [],
          visibility,
          isPublicActivity,
          searchConsent
        });
        ctx.emit('outbox.event.ready', event);
        await this.deliverObservationToSidecar(event);
      }
    },
    'activitypub.outbox.remote-delivery.handoff-queued': {
      async handler(ctx) {
        if (this.settings.remoteDeliveryMode !== 'external') return;
        const { activity, deliveryPlan } = ctx.params;
        if (!validateDeliveryPlanV1(deliveryPlan)) throw new Error('Refusing invalid ap.delivery-plan.v1 payload');
        if (deliveryPlan.activityId !== (activity.id || activity['@id'])) {
          throw new Error('Delivery Plan activityId does not match emitted Activity');
        }
        const actorUri = deliveryPlan.actorUri;
        const visibility = deliveryPlan.meta.visibility;
        const isPublicActivity = deliveryPlan.meta.isPublicActivity;
        const searchConsent = await this.buildSearchConsent(ctx, activity, actorUri);
        const deliveryTargets = deliveryPlan.remoteRecipients.map(target => ({
          targetDomain: target.targetDomain,
          inboxUrl: target.inboxUrl,
          ...(target.sharedInboxUrl ? { sharedInboxUrl: target.sharedInboxUrl } : {})
        }));
        const event = await this.buildCommittedEvent(ctx, {
          activity,
          actorUri,
          deliveryTargets,
          visibility,
          isPublicActivity,
          searchConsent,
          deliveryPlanIntentId: deliveryPlan.intentId
        });
        ctx.emit('outbox.event.ready', event);
      }
    }
  },
  methods: {
    async buildCommittedEvent(ctx, { activity, actorUri, deliveryTargets, visibility, isPublicActivity, searchConsent, deliveryPlanIntentId }) {
      return {
        schema: 'ap.outbox.committed.v1',
        eventId: ulid(),
        timestamp: new Date().toISOString(),
        actorUri,
        podDataset: ctx.meta?.podDataset,
        activityId: activity.id || activity['@id'],
        objectId: this.extractObjectId(activity),
        activityType: activity.type || activity['@type'],
        activity,
        deliveryTargets,
        meta: {
          isPublicActivity,
          isPublicIndexable: isPublicActivity && searchConsent.isPublic,
          isDeleteOrTombstone: this.isDeleteOrTombstone(activity),
          visibility,
          searchConsent,
          hashtags: this.extractMetadataHashtags(activity),
          ...(deliveryPlanIntentId ? { deliveryPlanIntentId } : {})
        }
      };
    },
    async deliverObservationToSidecar(event) {
      const payload = {
        actorUri: event.actorUri,
        activityId: event.activityId,
        activity: event.activity,
        meta: event.meta
      };
      const expectedIntentId = `apdm-observation:${event.eventId}`;
      try {
        await retryWithBackoff(async () => {
          const headers = {
            'Content-Type': 'application/json',
            'X-Event-Id': event.eventId,
            'X-Event-Schema': event.schema,
            Authorization: `Bearer ${this.settings.sidecarToken}`
          };
          const response = await fetch(this.settings.sidecarObservationWebhookUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(this.settings.observationWebhookTimeoutMs)
          });
          if (response.status !== 202) {
            const error = new Error(`Sidecar observation webhook returned ${response.status}; expected durable 202 acceptance`);
            error.retryable = response.status === 429 || response.status >= 500;
            throw error;
          }
          let acknowledgement;
          try {
            acknowledgement = await response.json();
          } catch {
            const error = new Error('Sidecar observation webhook returned an invalid acknowledgement body');
            error.retryable = true;
            throw error;
          }
          if (
            !acknowledgement ||
            acknowledgement.accepted !== true ||
            acknowledgement.intentId !== expectedIntentId ||
            acknowledgement.jobCount !== 0 ||
            acknowledgement.observationOnly !== true
          ) {
            const error = new Error('Sidecar observation webhook acknowledgement did not confirm the exact durable zero-target observation intent');
            error.retryable = true;
            throw error;
          }
        }, {
          maxRetries: Math.max(0, this.settings.observationWebhookRetries - 1),
          baseDelayMs: 250,
          maxDelayMs: 5000,
          retryIf: error => error.retryable !== false
        });
      } catch (error) {
        this.logger.error('Failed to deliver native observation to sidecar after retries', {
          eventId: event.eventId,
          activityId: event.activityId,
          error: error.message
        });
      }
    },
    extractObjectId(activity) {
      const object = activity.object;
      if (!object) return null;
      if (typeof object === 'string') return object;
      return object.id || object['@id'] || null;
    },
    isDeleteOrTombstone(activity) {
      const type = activity.type || activity['@type'];
      return type === 'Delete' || type === 'Tombstone' || (type === 'Undo' && activity.object?.type === 'Announce');
    },
    determineVisibility(activity) {
      const publicAddress = 'https://www.w3.org/ns/activitystreams#Public';
      const to = Array.isArray(activity.to) ? activity.to : [activity.to];
      const cc = Array.isArray(activity.cc) ? activity.cc : [activity.cc];
      if (to.includes(publicAddress) || to.includes('as:Public')) return 'public';
      if (cc.includes(publicAddress) || cc.includes('as:Public')) return 'unlisted';
      if (to.some(r => r?.endsWith('/followers'))) return 'followers';
      return 'direct';
    },
    async buildSearchConsent(ctx, activity, actorUri) {
      const obj = activity.object && typeof activity.object === 'object' ? activity.object : activity;
      let attributedToActor = null;
      if (actorUri && typeof ctx.call === 'function') {
        attributedToActor = await Promise.resolve(ctx.call('activitypub.actor.get', { actorUri, webId: 'system' })).catch(error => {
          this.logger.warn('Failed to resolve actor search consent for outbox event', { actorUri, error: error.message });
          return null;
        });
      }
      return resolvePublicSearchConsent(obj, { attributedToActor });
    },
    extractMetadataHashtags(activity) {
      const obj = activity.object && typeof activity.object === 'object' ? activity.object : activity;
      return extractHashtagsFromText(obj.content || '');
    }
  }
};
