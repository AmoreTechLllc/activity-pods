'use strict';

const Redis = require('ioredis');
const { MIME_TYPES } = require('@semapps/mime-types');
const { sanitizeSparqlQuery } = require('@semapps/triplestore');
const CONFIG = require('../config/config');
const { buildDeliveryPlanV1, mapWithConcurrency } = require('../utils/activitypub-delivery-planner');

const ACCOUNT_CURSOR_KEY = 'apdm:delivery-reconciliation:account-offset:v1';

function isExternalMode() {
  return String(CONFIG.ACTIVITYPUB_REMOTE_DELIVERY_MODE || 'native').trim().toLowerCase() === 'external';
}

module.exports = {
  name: 'activitypub-delivery-reconciler',

  dependencies: [
    'auth.account',
    'activitypub.actor',
    'activitypub.activity',
    'activitypub.outbox',
    'triplestore'
  ],

  settings: {
    enabled: isExternalMode(),
    baseUri: CONFIG.BASE_URL,
    queueServiceUrl: CONFIG.QUEUE_SERVICE_URL,
    intervalMs: CONFIG.ACTIVITYPUB_DELIVERY_RECONCILIATION_INTERVAL_MS,
    initialDelayMs: CONFIG.ACTIVITYPUB_DELIVERY_RECONCILIATION_INITIAL_DELAY_MS,
    lookbackMs: CONFIG.ACTIVITYPUB_DELIVERY_RECONCILIATION_LOOKBACK_MS,
    accountBatchSize: CONFIG.ACTIVITYPUB_DELIVERY_RECONCILIATION_ACCOUNT_BATCH_SIZE,
    maxActivitiesPerAccount: CONFIG.ACTIVITYPUB_DELIVERY_RECONCILIATION_MAX_ACTIVITIES_PER_ACCOUNT,
    concurrency: CONFIG.ACTIVITYPUB_DELIVERY_RECONCILIATION_CONCURRENCY,
    accountCursorKey: ACCOUNT_CURSOR_KEY
  },

  created() {
    this.reconciliationTimer = null;
    this.reconciliationStartTimer = null;
    this.reconciliationRedis = null;
    this.reconciliationRunning = false;
    this.reconciliationStats = {
      runs: 0,
      accountsScanned: 0,
      activitiesScanned: 0,
      handoffsRequeued: 0,
      failures: 0,
      accountOffset: 0,
      lastRunStartedAt: null,
      lastRunCompletedAt: null,
      lastError: null
    };
  },

  async started() {
    if (!this.settings.enabled) return;
    if (typeof this.settings.baseUri !== 'string' || this.settings.baseUri.length === 0) {
      throw new Error('ActivityPub delivery reconciliation requires a configured provider base URI');
    }
    if (typeof this.settings.queueServiceUrl !== 'string' || this.settings.queueServiceUrl.length === 0) {
      throw new Error('ActivityPub delivery reconciliation requires SEMAPPS_QUEUE_SERVICE_URL');
    }

    this.reconciliationRedis = new Redis(this.settings.queueServiceUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true
    });
    this.reconciliationRedis.on('error', error => {
      this.logger.error('ActivityPub reconciliation Redis error', { error: error.message });
    });
    await this.reconciliationRedis.connect();
    await this.reconciliationRedis.ping();

    const intervalMs = Math.max(10000, Number(this.settings.intervalMs) || 60000);
    const initialDelayMs = Math.max(1000, Number(this.settings.initialDelayMs) || 15000);
    const run = () => {
      this.broker.call('activitypub-delivery-reconciler.run', {}, { meta: { webId: 'system' } }).catch(error => {
        this.logger.error('ActivityPub delivery reconciliation run failed', { error: error.message });
      });
    };

    this.reconciliationStartTimer = setTimeout(run, initialDelayMs);
    this.reconciliationTimer = setInterval(run, intervalMs);
  },

  async stopped() {
    if (this.reconciliationStartTimer) clearTimeout(this.reconciliationStartTimer);
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
    this.reconciliationStartTimer = null;
    this.reconciliationTimer = null;
    if (this.reconciliationRedis) {
      await this.reconciliationRedis.quit().catch(() => this.reconciliationRedis.disconnect());
      this.reconciliationRedis = null;
    }
  },

  actions: {
    run: {
      async handler(ctx) {
        if (!this.settings.enabled) return { skipped: true, reason: 'external delivery disabled' };
        if (this.reconciliationRunning) return { skipped: true, reason: 'reconciliation already running' };

        this.reconciliationRunning = true;
        this.reconciliationStats.runs += 1;
        this.reconciliationStats.lastRunStartedAt = new Date().toISOString();
        this.reconciliationStats.lastError = null;

        try {
          const batchSize = Math.max(1, Math.min(5000, Math.floor(Number(this.settings.accountBatchSize) || 500)));
          let offset = await this.getAccountOffset();
          let accounts = await ctx.call('auth.account.find', { limit: batchSize, offset });

          // Wrap after reaching the end. The cursor lives in Redis so large
          // providers eventually scan every account across runs and restarts.
          if ((!Array.isArray(accounts) || accounts.length === 0) && offset > 0) {
            offset = 0;
            accounts = await ctx.call('auth.account.find', { limit: batchSize, offset: 0 });
          }

          const rawAccounts = Array.isArray(accounts) ? accounts : [];
          const activeAccounts = rawAccounts.filter(
            account => account && !account.deletedAt && typeof account.webId === 'string' && typeof account.username === 'string'
          );

          const results = await mapWithConcurrency(
            activeAccounts,
            Math.max(1, Math.floor(Number(this.settings.concurrency) || 4)),
            account => this.reconcileAccount(ctx, account)
          );

          const summary = results.reduce(
            (acc, result) => ({
              accountsScanned: acc.accountsScanned + 1,
              activitiesScanned: acc.activitiesScanned + result.activitiesScanned,
              handoffsRequeued: acc.handoffsRequeued + result.handoffsRequeued,
              failures: acc.failures + result.failures
            }),
            { accountsScanned: 0, activitiesScanned: 0, handoffsRequeued: 0, failures: 0 }
          );

          const nextOffset = rawAccounts.length < batchSize ? 0 : offset + rawAccounts.length;
          await this.setAccountOffset(nextOffset);

          this.reconciliationStats.accountsScanned += summary.accountsScanned;
          this.reconciliationStats.activitiesScanned += summary.activitiesScanned;
          this.reconciliationStats.handoffsRequeued += summary.handoffsRequeued;
          this.reconciliationStats.failures += summary.failures;
          this.reconciliationStats.accountOffset = nextOffset;
          this.reconciliationStats.lastRunCompletedAt = new Date().toISOString();

          this.logger.info('ActivityPub delivery reconciliation completed', { ...summary, nextAccountOffset: nextOffset });
          return { ...summary, nextAccountOffset: nextOffset };
        } catch (error) {
          this.reconciliationStats.failures += 1;
          this.reconciliationStats.lastError = error.message;
          throw error;
        } finally {
          this.reconciliationRunning = false;
        }
      }
    },

    getStats: {
      handler() {
        return { ...this.reconciliationStats, running: this.reconciliationRunning };
      }
    }
  },

  methods: {
    async getAccountOffset() {
      if (!this.reconciliationRedis) throw new Error('ActivityPub reconciliation Redis is not initialized');
      const raw = await this.reconciliationRedis.get(this.settings.accountCursorKey);
      const parsed = Number.parseInt(raw || '0', 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    },

    async setAccountOffset(offset) {
      if (!this.reconciliationRedis) throw new Error('ActivityPub reconciliation Redis is not initialized');
      await this.reconciliationRedis.set(this.settings.accountCursorKey, String(Math.max(0, Math.floor(offset))));
    },

    async reconcileAccount(ctx, account) {
      const dataset = account.username;
      let activitiesScanned = 0;
      let handoffsRequeued = 0;
      let failures = 0;

      try {
        const outboxUri = await ctx.call(
          'activitypub.actor.getCollectionUri',
          { actorUri: account.webId, predicate: 'outbox', webId: 'system' },
          { meta: { dataset } }
        );
        if (typeof outboxUri !== 'string' || outboxUri.length === 0) {
          return { activitiesScanned, handoffsRequeued, failures: failures + 1 };
        }

        const cutoffMs = Date.now() - Math.max(60000, Number(this.settings.lookbackMs) || 900000);
        const maxActivities = Math.max(1, Math.min(1000, Math.floor(Number(this.settings.maxActivitiesPerAccount) || 50)));
        const queryBody = sanitizeSparqlQuery`
          PREFIX as: <https://www.w3.org/ns/activitystreams#>
          SELECT ?activityUri ?published
          WHERE {
            <${outboxUri}> as:items ?activityUri .
            ?activityUri as:published ?published .
          }
          ORDER BY DESC(?published)
        `;
        const rows = await ctx.call('triplestore.query', {
          query: `${queryBody}\nLIMIT ${maxActivities}`,
          accept: MIME_TYPES.JSON,
          dataset,
          webId: 'system'
        });

        for (const row of rows || []) {
          const activityUri = row?.activityUri?.value;
          if (typeof activityUri !== 'string' || activityUri.length === 0) continue;
          activitiesScanned += 1;

          try {
            const activity = await ctx.call(
              'activitypub.activity.get',
              { resourceUri: activityUri, webId: 'system' },
              { meta: { dataset } }
            );
            const publishedMs = Date.parse(activity?.published || row?.published?.value || '');
            if (!Number.isFinite(publishedMs) || publishedMs < cutoffMs) continue;

            const recipients = await ctx.call('activitypub.activity.getRecipients', { activity });
            const localRecipientUris = [];
            const remoteRecipientUris = [];

            for (const recipientUri of recipients || []) {
              if (typeof recipientUri !== 'string' || recipientUri.length === 0) continue;
              if (recipientUri.startsWith(this.settings.baseUri)) {
                const localAccount = await ctx.call('auth.account.findByWebId', { webId: recipientUri });
                if (localAccount) localRecipientUris.push(recipientUri);
              } else {
                remoteRecipientUris.push(recipientUri);
              }
            }

            if (remoteRecipientUris.length === 0) continue;

            const deliveryPlan = await buildDeliveryPlanV1(ctx, {
              activity,
              localRecipientUris,
              remoteRecipientUris,
              podProvider: true
            });

            await ctx.call('activitypub.outbox.enqueueDeliveryHandoff', { deliveryPlan });
            handoffsRequeued += 1;
          } catch (error) {
            failures += 1;
            this.logger.warn('Failed to reconcile persisted ActivityPub delivery', {
              activityUri,
              actorUri: account.webId,
              error: error.message
            });
          }
        }
      } catch (error) {
        failures += 1;
        this.logger.warn('Failed to scan ActivityPub outbox during delivery reconciliation', {
          actorUri: account.webId,
          dataset,
          error: error.message
        });
      }

      return { activitiesScanned, handoffsRequeued, failures };
    }
  }
};