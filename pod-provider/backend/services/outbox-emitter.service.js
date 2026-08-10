/**
 * ActivityPods Outbox Event Emitter Service
 *
 * This Moleculer service emits events when activities are committed to outboxes.
 * The sidecar listens to these events to:
 * 1. Produce to RedPanda Stream1 (for public activities)
 * 2. Create delivery jobs in Redis (for remote federation)
 *
 * This replaces the "watch outboxes via Solid Notifications" approach with
 * a more reliable event-driven pattern.
 */
'use strict';

const { ulid } = require('ulid');
const { retryWithBackoff } = require('../utils/backoff');
const { validateDeliveryPlanV1 } = require('../utils/activitypub-delivery-plan');
const { resolvePublicSearchConsent } = require('../utils/search-consent');
const { extractHashtagsFromText } = require('../utils/hashtags');

module.exports = {
  name: 'outbox-emitter',

  dependencies: ['activitypub.outbox', 'followable'],

  settings: {
    // Sidecar webhook URL for event delivery
    sidecarWebhookUrl: process.env.SIDECAR_WEBHOOK_URL || 'http://fedify-sidecar:8080/webhook/outbox',
    sidecarToken: process.env.SIDECAR_TOKEN || '',

    // During APDM native mode keeps the legacy raw-activity route. External
    // preview mode ignores it and waits for the authoritative Delivery Plan.
    remoteDeliveryMode: String(process.env.SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE || 'native')
      .trim()
      .toLowerCase(),

    // Retry settings for webhook delivery
    webhookRetries: Number(process.env.WEBHOOK_RETRIES) || 3,
    webhookTimeoutMs: Number(process.env.WEBHOOK_TIMEOUT_MS) || 5000
  },

  events: {
    /**
     * Legacy/native path. In external-preview mode this event is deliberately
     * ignored because it contains only the raw Activity and fires before the
     * APDM wrapper can expose SemApps' already-expanded recipient partition.
     */
    'activitypub.outbox.posted': {
      async handler(ctx) {
        if (this.settings.remoteDeliveryMode === 'external') {
          this.logger.debug('Ignoring raw outbox.posted routing event in APDM external preview mode');
          return;
        }

        const { activity } = ctx.params;
        const actorUri = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id || null;
        const visibility = this.determineVisibility(activity);
        const isPublicActivity = visibility === 'public' || visibility === 'unlisted';
        const searchConsent = await this.buildSearchConsent(ctx, activity, actorUri);

        // Resolve remote delivery targets (not provided by stock SemApps in this event)
        let deliveryTargets = [];
        if (actorUri) {
          try {
            const result = await ctx.call('outbox-emitter.resolveDeliveryTargets', { actorUri, activity });
            deliveryTargets = result.targets || [];
          } catch (err) {
            this.logger.warn('Failed to resolve delivery targets', { actorUri, error: err.message });
          }
        }

        const event = await this.buildCommittedEvent(ctx, {
          activity,
          actorUri,
          deliveryTargets,
          visibility,
          isPublicActivity,
          searchConsent
        });

        ctx.emit('outbox.event.ready', event);
        await this.deliverToSidecar(ctx, event);
      }
    },

    /**
     * APDM Phase 3 external-preview routing path. The delivery plan contains
     * concrete recipients derived from SemApps' already-expanded partition.
     */
    'activitypub.outbox.remote-delivery.planned': {
      async handler(ctx) {
        if (this.settings.remoteDeliveryMode !== 'external') return;

        const { activity, deliveryPlan } = ctx.params;
        if (!validateDeliveryPlanV1(deliveryPlan)) {
          throw new Error('Refusing invalid ap.delivery-plan.v1 payload');
        }
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
        await this.deliverToSidecar(ctx, event);
      }
    }
  },

  actions: {
    /**
     * Manually emit an outbox event (for testing/reconciliation).
     */
    emitEvent: {
      params: {
        actorUri: { type: 'string' },
        activity: { type: 'object' },
        deliveryTargets: { type: 'array', optional: true }
      },
      async handler(ctx) {
        const { actorUri, activity, deliveryTargets } = ctx.params;
        const visibility = this.determineVisibility(activity);
        const isPublicActivity = visibility === 'public' || visibility === 'unlisted';
        const searchConsent = await this.buildSearchConsent(ctx, activity, actorUri);

        const event = await this.buildCommittedEvent(ctx, {
          activity,
          actorUri,
          deliveryTargets: deliveryTargets || [],
          visibility,
          isPublicActivity,
          searchConsent
        });

        await this.deliverToSidecar(ctx, event);
        return { success: true, eventId: event.eventId };
      }
    },

    /**
     * Resolve delivery targets for an activity.
     * Kept as a native-mode compatibility path during APDM. External preview
     * does not use this raw-address parser as its routing authority.
     */
    resolveDeliveryTargets: {
      params: {
        actorUri: { type: 'string' },
        activity: { type: 'object' }
      },
      async handler(ctx) {
        const { actorUri, activity } = ctx.params;

        if (this.isFollowActivity(activity)) {
          const resolved = await ctx.call('followable.resolveFollowActivityDelivery', {
            activity,
            recursionLimit: 1,
            requireFollowersCollection: true,
            webId: 'system'
          });

          if (this.isLikelyLocalDelivery(actorUri, resolved.delivery)) {
            return { targets: [] };
          }

          return {
            targets: [this.toWebhookDeliveryTarget(resolved.delivery)]
          };
        }

        const recipients = this.extractRecipients(activity);

        // Legacy/native compatibility path only. APDM external preview uses the
        // bounded authoritative planner instead of this unbounded Promise.all.
        const targetResults = await Promise.all(
          recipients.map(async recipientUri => {
            try {
              const isLocal = await ctx.call('activitypub.actor.isLocal', { actorUri: recipientUri });
              if (isLocal) return null;

              const actorDoc = await ctx.call('activitypub.actor.get', { actorUri: recipientUri });
              if (actorDoc) {
                const host = new URL(recipientUri).hostname;
                return {
                  targetDomain: host,
                  inboxUrl: actorDoc.inbox,
                  sharedInboxUrl: actorDoc.endpoints?.sharedInbox || actorDoc.inbox
                };
              }
            } catch (err) {
              this.logger.warn('Failed to resolve recipient', { recipientUri, error: err.message });
            }
            return null;
          })
        );

        const targets = targetResults.filter(t => t !== null);
        const deduped = this.deduplicateBySharedInbox(targets);
        return { targets: deduped };
      }
    }
  },

  methods: {
    async buildCommittedEvent(
      ctx,
      { activity, actorUri, deliveryTargets, visibility, isPublicActivity, searchConsent, deliveryPlanIntentId }
    ) {
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

    /**
     * Deliver event to sidecar webhook.
     */
    async deliverToSidecar(ctx, event) {
      const url = this.settings.sidecarWebhookUrl;

      const payload = {
        actorUri: event.actorUri,
        activityId: event.activityId,
        activity: event.activity,
        remoteTargets: event.deliveryTargets,
        meta: event.meta
      };

      try {
        await retryWithBackoff(
          async () => {
            const headers = {
              'Content-Type': 'application/json',
              'X-Event-Id': event.eventId,
              'X-Event-Schema': event.schema
            };
            if (this.settings.sidecarToken) {
              headers.Authorization = `Bearer ${this.settings.sidecarToken}`;
            }

            const response = await fetch(url, {
              method: 'POST',
              headers,
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(this.settings.webhookTimeoutMs)
            });

            if (!response.ok) {
              const error = new Error(`Sidecar webhook returned ${response.status}`);
              error.retryable = response.status === 429 || response.status >= 500;
              throw error;
            }

            this.logger.debug('Delivered event to sidecar', {
              eventId: event.eventId,
              activityId: event.activityId
            });
          },
          {
            maxRetries: Math.max(0, this.settings.webhookRetries - 1),
            baseDelayMs: 250,
            maxDelayMs: 5000,
            retryIf: err => err.retryable !== false
          }
        );
      } catch (err) {
        this.logger.error('Failed to deliver event to sidecar after retries', {
          eventId: event.eventId,
          activityId: event.activityId,
          error: err.message
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
        attributedToActor = await Promise.resolve(
          ctx.call('activitypub.actor.get', {
            actorUri,
            webId: 'system'
          })
        ).catch(error => {
          this.logger.warn('Failed to resolve actor search consent for outbox event', {
            actorUri,
            error: error.message
          });
          return null;
        });
      }

      return resolvePublicSearchConsent(obj, { attributedToActor });
    },

    extractMetadataHashtags(activity) {
      const obj = activity.object && typeof activity.object === 'object' ? activity.object : activity;
      return extractHashtagsFromText(obj.content || '');
    },

    extractRecipients(activity) {
      const recipients = new Set();

      for (const field of ['to', 'cc', 'bto', 'bcc']) {
        const values = activity[field];
        if (!values) continue;

        const arr = Array.isArray(values) ? values : [values];
        for (const value of arr) {
          if (typeof value === 'string' && value.startsWith('http')) recipients.add(value);
        }
      }

      return [...recipients];
    },

    deduplicateBySharedInbox(targets) {
      const seen = new Map();
      for (const target of targets) {
        const key = target.sharedInboxUrl || target.inboxUrl;
        if (!seen.has(key)) seen.set(key, target);
      }
      return [...seen.values()];
    },

    isFollowActivity(activity) {
      const type = activity?.type || activity?.['@type'];
      return type === 'Follow';
    },

    toWebhookDeliveryTarget(delivery) {
      return {
        targetDomain: delivery.targetDomain,
        inboxUrl: delivery.recipients[0],
        ...(delivery.sharedInbox ? { sharedInboxUrl: delivery.sharedInbox } : {})
      };
    },

    isLikelyLocalDelivery(actorUri, delivery) {
      try {
        const actorOrigin = new URL(actorUri).origin;
        const inboxOrigin = new URL(delivery.recipients[0]).origin;
        return actorOrigin === inboxOrigin;
      } catch {
        return false;
      }
    }
  }
};
