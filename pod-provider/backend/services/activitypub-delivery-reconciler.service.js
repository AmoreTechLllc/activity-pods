'use strict';

const { MIME_TYPES } = require('@semapps/mime-types');
const { sanitizeSparqlQuery } = require('@semapps/triplestore');
const CONFIG = require('../config/config');
const { buildDeliveryPlanV1, mapWithConcurrency } = require('../utils/activitypub-delivery-planner');

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
    intervalMs: CONFIG.ACTIVITYPUB_DELIVERY_RECONCILIATION_INTERVAL_MS,
    initialDelayMs: CONFIG.ACTIVITYPUB_DELIVERY_RECONCILIATION_INITIAL_DELAY_MS,
    lookbackMs: CONFIG.ACTIVITYPUB_DELIVERY_RECONCILIATION_LOOKBACK_MS,
    maxAccounts: CONFIG.ACTIVITYPUB_DELIVERY_RECONCILIATION_MAX_ACCOUNTS,
    maxActivitiesPerAccount: CONFIG.ACTIVITYPUB_DELIVERY_RECONCILIATION_MAX_ACTIVITIES_PER_ACCOUNT,
    concurrency: CONFIG.ACTIVITYPUB_DELIVERY_RECONCILIATION_CONCURRENCY
  },

  created() {
    this.reconciliationTimer = null;
    this.reconciliationStartTimer = null;
    this.reconciliationRunning = false;
    this.reconciliationStats = {
      runs: 0,
      accountsScanned: 0,
      activitiesScanned: 0,
      handoffsRequeued: 0,
      failures: 0,
      lastRunStartedAt: null,
      lastRunCompletedAt: null,
      lastError: null
    };
  },

  started() {
    if (!this.settings.enabled) return;
    if (typeof this.settings.baseUri !== 'string' || this.settings.baseUri.length === 0) {
      throw new Error('ActivityPub delivery reconciliation requires a configured provider base URI');
    }

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

  stopped() {
    if (this.reconciliationStartTimer) clearTimeout(this.reconciliationStartTimer);
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
    this.reconciliationStartTimer = null;
    this.reconciliationTimer = null;
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
          const accounts = await ctx.call('auth.account.find', {});
          const activeAccounts = (Array.isArray(accounts) ? accounts : [])
            .filter(account => account && !account.deletedAt && typeof account.webId === 'string' && typeof account.username === 'string')
            .slice(0, Math.max(1, Math.floor(Number(this.settings.maxAccounts) || 1000)));

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

          this.reconciliationStats.accountsScanned += summary.accountsScanned;
          this.reconciliationStats.activitiesScanned += summary.activitiesScanned;
          this.reconciliationStats.handoffsRequeued += summary.handoffsRequeued;
          this.reconciliationStats.failures += summary.failures;
          this.reconciliationStats.lastRunCompletedAt = new Date().toISOString();

          this.logger.info('ActivityPub delivery reconciliation completed', summary);
          return summary;
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

        const sinceIso = new Date(Date.now() - Math.max(60000, Number(this.settings.lookbackMs) || 900000)).toISOString();
        const maxActivities = Math.max(1, Math.min(1000, Math.floor(Number(this.settings.maxActivitiesPerAccount) || 50)));
        const queryBody = sanitizeSparqlQuery`
          PREFIX as: <https://www.w3.org/ns/activitystreams#>
          PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
          SELECT ?activityUri ?published
          WHERE {
            <${outboxUri}> as:items ?activityUri .
            ?activityUri as:published ?published .
            FILTER(?published >= "${sinceIso}"^^xsd:dateTime)
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