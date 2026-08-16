'use strict';

const crypto = require('crypto');
const Redis = require('ioredis');
const { MIME_TYPES } = require('@semapps/mime-types');
const { sanitizeSparqlQuery } = require('@semapps/triplestore');
const CONFIG = require('../config/config');
const {
  buildDeliveryPlanV1,
  mapWithConcurrency,
  resolveLocalOutboxUri
} = require('../utils/activitypub-delivery-planner');

const ACCOUNT_CURSOR_KEY = 'apdm:delivery-reconciliation:account-keyset:v2';
const RECONCILIATION_LOCK_KEY = 'apdm:delivery-reconciliation:lock:v1';
const BLIND_SNAPSHOT_PREFIX = 'apdm:delivery-reconciliation:blind:v1:';
const BLIND_SNAPSHOT_TTL_SECONDS = 259200;
const LOCAL_ACCOUNT_BATCH_MAX_COUNT = 250;
const LOCAL_ACCOUNT_BATCH_MAX_IRI_BYTES = 65536;
const LOCAL_ACCOUNT_MAX_WEBID_LENGTH = 4096;

function isExternalMode() {
  return String(CONFIG.ACTIVITYPUB_REMOTE_DELIVERY_MODE || 'native').trim().toLowerCase() === 'external';
}

function actorUriOf(activity) {
  return typeof activity?.actor === 'string' ? activity.actor : activity?.actor?.id || activity?.actor?.['@id'] || null;
}

function entityId(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value.id || value['@id'] || null;
  return null;
}

function normalizedStrings(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map(entityId).filter(item => typeof item === 'string' && item.length > 0).sort();
}

function activityTypeValues(activity) {
  const raw = activity?.type ?? activity?.['@type'];
  return normalizedStrings(raw);
}

function blindSnapshotIdentity(activity) {
  if (!activity || typeof activity !== 'object' || Array.isArray(activity)) {
    throw new TypeError('Blind recipient snapshot requires an Activity object');
  }
  const actor = actorUriOf(activity);
  const published = typeof activity.published === 'string' ? activity.published : null;
  const object = entityId(activity.object);
  const types = activityTypeValues(activity);
  if (!actor || !published || types.length === 0) {
    throw new Error('Blind recipient snapshot requires actor, published, and type');
  }
  const material = JSON.stringify({
    actor,
    published,
    object,
    types,
    to: normalizedStrings(activity.to),
    cc: normalizedStrings(activity.cc),
    audience: normalizedStrings(activity.audience)
  });
  return crypto.createHash('sha256').update(material).digest('hex');
}

function sanitizeBlindSnapshot({ bto, bcc }) {
  const snapshot = {};
  const normalizedBto = normalizedStrings(bto);
  const normalizedBcc = normalizedStrings(bcc);
  if (normalizedBto.length > 0) snapshot.bto = normalizedBto;
  if (normalizedBcc.length > 0) snapshot.bcc = normalizedBcc;
  return snapshot;
}

function collectionItemUris(collection) {
  const items = collection?.items || collection?.orderedItems || [];
  return (Array.isArray(items) ? items : [items])
    .map(item => (typeof item === 'string' ? item : item?.id || item?.['@id']))
    .filter(uri => typeof uri === 'string' && uri.length > 0);
}

function normalizeTrailingSlash(value) {
  return typeof value === 'string' ? value.replace(/\/+$/u, '') : '';
}

function isSenderFollowersCollection(recipientUri, actorUri) {
  const normalizedRecipient = normalizeTrailingSlash(recipientUri);
  const normalizedActor = normalizeTrailingSlash(actorUri);
  return normalizedRecipient.length > 0 && normalizedActor.length > 0 && normalizedRecipient === `${normalizedActor}/followers`;
}

module.exports = {
  name: 'activitypub-delivery-reconciler',

  dependencies: [
    'auth.account',
    'activitypub.actor',
    'activitypub.activity',
    'activitypub.collection',
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
    accountsDataset: CONFIG.AUTH_ACCOUNTS_DATASET,
    accountCursorKey: ACCOUNT_CURSOR_KEY,
    reconciliationLockKey: RECONCILIATION_LOCK_KEY,
    blindSnapshotPrefix: BLIND_SNAPSHOT_PREFIX,
    blindSnapshotTtlSeconds: BLIND_SNAPSHOT_TTL_SECONDS
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
      accountCursor: null,
      distributedLockSkips: 0,
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
    if (typeof this.settings.accountsDataset !== 'string' || this.settings.accountsDataset.length === 0) {
      throw new Error('ActivityPub delivery reconciliation requires SEMAPPS_AUTH_ACCOUNTS_DATASET');
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
    storeBlindRecipientSnapshot: {
      params: {
        activity: { type: 'object' },
        bto: { type: 'any', optional: true },
        bcc: { type: 'any', optional: true }
      },
      async handler(ctx) {
        if (!this.settings.enabled) throw new Error('Blind recipient snapshots require external delivery mode');
        if (!this.reconciliationRedis) throw new Error('ActivityPub reconciliation Redis is not initialized');
        const snapshot = sanitizeBlindSnapshot(ctx.params);
        if (Object.keys(snapshot).length === 0) return { stored: false };
        const identity = blindSnapshotIdentity(ctx.params.activity);
        const key = `${this.settings.blindSnapshotPrefix}${identity}`;
        await this.reconciliationRedis.set(
          key,
          JSON.stringify(snapshot),
          'EX',
          Math.max(60, Number(this.settings.blindSnapshotTtlSeconds) || BLIND_SNAPSHOT_TTL_SECONDS)
        );
        return { stored: true, identity };
      }
    },

    run: {
      async handler(ctx) {
        if (!this.settings.enabled) return { skipped: true, reason: 'external delivery disabled' };
        if (this.reconciliationRunning) return { skipped: true, reason: 'reconciliation already running' };

        const leaseToken = await this.acquireDistributedLease();
        if (!leaseToken) {
          this.reconciliationStats.distributedLockSkips += 1;
          return { skipped: true, reason: 'reconciliation active on another provider process' };
        }

        this.reconciliationRunning = true;
        this.reconciliationStats.runs += 1;
        this.reconciliationStats.lastRunStartedAt = new Date().toISOString();
        this.reconciliationStats.lastError = null;

        try {
          const batchSize = Math.max(1, Math.min(5000, Math.floor(Number(this.settings.accountBatchSize) || 500)));
          let cursor = await this.getAccountCursor();
          let page = await this.listAccountPage(ctx, { cursor, limit: batchSize });

          if (page.accounts.length === 0 && cursor) {
            cursor = null;
            page = await this.listAccountPage(ctx, { cursor: null, limit: batchSize });
          }

          const activeAccounts = page.accounts;
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

          const nextCursor = activeAccounts.length < batchSize ? null : page.nextCursor;
          await this.setAccountCursor(nextCursor);

          this.reconciliationStats.accountsScanned += summary.accountsScanned;
          this.reconciliationStats.activitiesScanned += summary.activitiesScanned;
          this.reconciliationStats.handoffsRequeued += summary.handoffsRequeued;
          this.reconciliationStats.failures += summary.failures;
          this.reconciliationStats.accountOffset = 0;
          this.reconciliationStats.accountCursor = nextCursor;
          this.reconciliationStats.lastRunCompletedAt = new Date().toISOString();

          this.logger.info('ActivityPub delivery reconciliation completed', { ...summary, nextAccountCursor: nextCursor });
          return { ...summary, nextAccountOffset: 0, nextAccountCursor: nextCursor };
        } catch (error) {
          this.reconciliationStats.failures += 1;
          this.reconciliationStats.lastError = error.message;
          throw error;
        } finally {
          this.reconciliationRunning = false;
          await this.releaseDistributedLease(leaseToken).catch(error => {
            this.logger.error('Failed to release ActivityPub reconciliation lease', { error: error.message });
          });
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
    blindSnapshotIdentity,

    async loadBlindRecipientSnapshot(activity) {
      if (!this.reconciliationRedis) return null;
      let identity;
      try {
        identity = blindSnapshotIdentity(activity);
      } catch {
        return null;
      }
      const raw = await this.reconciliationRedis.get(`${this.settings.blindSnapshotPrefix}${identity}`);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        return sanitizeBlindSnapshot(parsed);
      } catch {
        return null;
      }
    },

    async acquireDistributedLease() {
      if (!this.reconciliationRedis) throw new Error('ActivityPub reconciliation Redis is not initialized');
      const token = crypto.randomUUID();
      const ttlMs = Math.max(120000, Number(this.settings.intervalMs) * 2 || 120000);
      const result = await this.reconciliationRedis.set(
        this.settings.reconciliationLockKey,
        token,
        'PX',
        ttlMs,
        'NX'
      );
      return result === 'OK' ? token : null;
    },

    async releaseDistributedLease(token) {
      if (!this.reconciliationRedis || !token) return false;
      const result = await this.reconciliationRedis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        this.settings.reconciliationLockKey,
        token
      );
      return result === 1;
    },

    async getAccountCursor() {
      if (!this.reconciliationRedis) throw new Error('ActivityPub reconciliation Redis is not initialized');
      const raw = await this.reconciliationRedis.get(this.settings.accountCursorKey);
      return typeof raw === 'string' && raw.length > 0 ? raw : null;
    },

    async setAccountCursor(cursor) {
      if (!this.reconciliationRedis) throw new Error('ActivityPub reconciliation Redis is not initialized');
      if (!cursor) {
        await this.reconciliationRedis.del(this.settings.accountCursorKey);
        return;
      }
      await this.reconciliationRedis.set(this.settings.accountCursorKey, cursor);
    },

    async listAccountPage(ctx, { cursor, limit }) {
      const boundedLimit = Math.max(1, Math.min(5000, Math.floor(Number(limit) || 500)));
      const cursorFilter = cursor ? sanitizeSparqlQuery`FILTER(STR(?accountUri) > "${cursor}")` : '';
      const queryBody = `
        PREFIX semapps: <http://semapps.org/ns/core#>
        SELECT ?accountUri ?webId ?username
        WHERE {
          ?accountUri a semapps:AuthAccount ;
            semapps:webId ?webId ;
            semapps:username ?username .
          FILTER NOT EXISTS { ?accountUri semapps:deletedAt ?deletedAt . }
          ${cursorFilter}
        }
        ORDER BY STR(?accountUri)
      `;
      const rows = await ctx.call('triplestore.query', {
        query: `${queryBody}\nLIMIT ${boundedLimit}`,
        accept: MIME_TYPES.JSON,
        dataset: this.settings.accountsDataset,
        webId: 'system'
      });
      const rawRows = Array.isArray(rows) ? rows : [];
      const accounts = rawRows
        .map(row => ({
          '@id': row?.accountUri?.value,
          webId: row?.webId?.value,
          username: row?.username?.value
        }))
        .filter(
          account =>
            typeof account['@id'] === 'string' &&
            typeof account.webId === 'string' &&
            typeof account.username === 'string'
        );
      const lastAccountUri = rawRows[rawRows.length - 1]?.accountUri?.value;
      return {
        accounts,
        nextCursor: typeof lastAccountUri === 'string' && lastAccountUri.length > 0 ? lastAccountUri : cursor || null
      };
    },

    async findLocalAccountsByWebIds(ctx, webIds) {
      const requestedWebIds = new Set((webIds || []).filter(value => typeof value === 'string' && value.length > 0));
      if (requestedWebIds.size === 0) return new Map();

      const renderedIris = [...requestedWebIds].map(webId => {
        if (webId.length > LOCAL_ACCOUNT_MAX_WEBID_LENGTH) {
          throw new Error(`Local ActivityPub recipient WebID exceeds ${LOCAL_ACCOUNT_MAX_WEBID_LENGTH} characters`);
        }
        return { webId, iri: sanitizeSparqlQuery`<${webId}>` };
      });
      const batches = [];
      let batch = [];
      let batchBytes = 0;
      for (const entry of renderedIris) {
        const iriBytes = Buffer.byteLength(entry.iri, 'utf8');
        if (iriBytes > LOCAL_ACCOUNT_BATCH_MAX_IRI_BYTES) {
          throw new Error('Local ActivityPub recipient WebID exceeds bounded SPARQL payload size');
        }
        const separatorBytes = batch.length > 0 ? 1 : 0;
        if (
          batch.length > 0 &&
          (batch.length >= LOCAL_ACCOUNT_BATCH_MAX_COUNT ||
            batchBytes + separatorBytes + iriBytes > LOCAL_ACCOUNT_BATCH_MAX_IRI_BYTES)
        ) {
          batches.push(batch);
          batch = [];
          batchBytes = 0;
        }
        batchBytes += (batch.length > 0 ? 1 : 0) + iriBytes;
        batch.push(entry);
      }
      if (batch.length > 0) batches.push(batch);

      const accountsByWebId = new Map();
      for (const entries of batches) {
        const values = entries.map(entry => entry.iri).join(' ');
        const query = `
          PREFIX semapps: <http://semapps.org/ns/core#>
          SELECT ?accountUri ?webId ?username
          WHERE {
            VALUES ?webId { ${values} }
            ?accountUri a semapps:AuthAccount ;
              semapps:webId ?webId ;
              semapps:username ?username .
            FILTER NOT EXISTS { ?accountUri semapps:deletedAt ?deletedAt . }
          }
        `;
        const rows = await ctx.call('triplestore.query', {
          query,
          accept: MIME_TYPES.JSON,
          dataset: this.settings.accountsDataset,
          webId: 'system'
        });
        for (const row of Array.isArray(rows) ? rows : []) {
          const account = {
            '@id': row?.accountUri?.value,
            webId: row?.webId?.value,
            username: row?.username?.value
          };
          if (
            typeof account['@id'] !== 'string' ||
            typeof account.webId !== 'string' ||
            typeof account.username !== 'string' ||
            !requestedWebIds.has(account.webId)
          ) {
            continue;
          }
          const existing = accountsByWebId.get(account.webId);
          if (existing && (existing['@id'] !== account['@id'] || existing.username !== account.username)) {
            throw new Error(`Ambiguous local ActivityPub account records for ${account.webId}`);
          }
          accountsByWebId.set(account.webId, account);
        }
      }
      return accountsByWebId;
    },

    async resolveLocalOutboxUri(ctx, actorUri, dataset) {
      return resolveLocalOutboxUri(ctx, actorUri, dataset);
    },

    async listOutboxActivityPage(ctx, { outboxUri, dataset, cursor, limit, cutoffPublished }) {
      const boundedLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 50)));
      if (typeof cutoffPublished !== 'string' || cutoffPublished.length === 0) {
        throw new Error('Outbox reconciliation requires a cutoff published timestamp');
      }
      const cutoffFilter = sanitizeSparqlQuery`FILTER(STR(?published) >= "${cutoffPublished}")`;
      let cursorFilter = '';
      if (cursor) {
        const published = cursor.published;
        const activityUri = cursor.activityUri;
        if (typeof published !== 'string' || published.length === 0) throw new Error('Invalid outbox activity cursor published value');
        if (typeof activityUri !== 'string' || activityUri.length === 0) throw new Error('Invalid outbox activity cursor URI');
        cursorFilter = sanitizeSparqlQuery`
          FILTER(
            STR(?published) < "${published}" ||
            (STR(?published) = "${published}" && STR(?activityUri) > "${activityUri}")
          )
        `;
      }
      const queryBody = sanitizeSparqlQuery`
        PREFIX as: <https://www.w3.org/ns/activitystreams#>
        SELECT ?activityUri ?published
        WHERE {
          <${outboxUri}> as:items ?activityUri .
          ?activityUri as:published ?published .
          ${cutoffFilter}
          ${cursorFilter}
        }
        ORDER BY DESC(STR(?published)) ASC(STR(?activityUri))
      `;
      const rows = await ctx.call('triplestore.query', {
        query: `${queryBody}\nLIMIT ${boundedLimit}`,
        accept: MIME_TYPES.JSON,
        dataset,
        webId: 'system'
      });
      const page = Array.isArray(rows) ? rows : [];
      const lastRow = page[page.length - 1];
      const lastPublished = lastRow?.published?.value;
      const lastActivityUri = lastRow?.activityUri?.value;
      return {
        rows: page,
        nextCursor:
          typeof lastPublished === 'string' &&
          lastPublished.length > 0 &&
          typeof lastActivityUri === 'string' &&
          lastActivityUri.length > 0
            ? { published: lastPublished, activityUri: lastActivityUri }
            : cursor || null
      };
    },

    async listSenderFollowerUris(ctx, actorUri, dataset) {
      const normalizedActorUri = normalizeTrailingSlash(actorUri);
      if (!normalizedActorUri) throw new Error('Sender follower reconciliation requires an actor URI');
      if (typeof dataset !== 'string' || dataset.length === 0) {
        throw new Error(`Sender follower reconciliation requires a dataset for ${actorUri}`);
      }
      const collectionUri = `${normalizedActorUri}/followers`;
      const query = sanitizeSparqlQuery`
        PREFIX as: <https://www.w3.org/ns/activitystreams#>
        SELECT DISTINCT ?itemUri
        WHERE {
          <${collectionUri}> a as:Collection .
          OPTIONAL { <${collectionUri}> as:items ?itemUri . }
        }
      `;
      const rows = await ctx.call('triplestore.query', {
        query,
        accept: MIME_TYPES.SPARQL_JSON,
        dataset,
        webId: actorUri
      });
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error(`Unable to resolve sender followers collection ${collectionUri}`);
      }

      const itemUris = [];
      for (const row of rows) {
        if (!row || typeof row !== 'object') {
          throw new Error(`Malformed sender followers query result for ${collectionUri}`);
        }
        if (row.itemUri === undefined) continue;
        const value = row.itemUri?.value;
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error(`Malformed sender follower URI for ${collectionUri}`);
        }
        itemUris.push(value);
      }
      return [...new Set(itemUris)];
    },

    async expandConcreteRecipients(ctx, activity, recipients, dataset, senderFollowersSnapshot = null) {
      const actorUri = actorUriOf(activity);
      const output = [];
      for (const recipientUri of recipients || []) {
        if (typeof recipientUri !== 'string' || recipientUri.length === 0) continue;
        if (!/\/followers\/?$/u.test(recipientUri)) {
          output.push(recipientUri);
          continue;
        }

        if (!recipientUri.startsWith(this.settings.baseUri)) {
          throw new Error(`Cannot safely reconcile unresolved remote followers collection ${recipientUri}`);
        }

        const snapshotActorUri = senderFollowersSnapshot?.actorUri;
        const canReuseSnapshot =
          senderFollowersSnapshot &&
          typeof senderFollowersSnapshot === 'object' &&
          normalizeTrailingSlash(actorUri) === normalizeTrailingSlash(snapshotActorUri) &&
          isSenderFollowersCollection(recipientUri, snapshotActorUri);
        let expanded;
        if (canReuseSnapshot && Array.isArray(senderFollowersSnapshot.items)) {
          expanded = senderFollowersSnapshot.items;
        } else if (canReuseSnapshot) {
          expanded = await this.listSenderFollowerUris(ctx, snapshotActorUri, dataset);
          senderFollowersSnapshot.items = Object.freeze([...expanded]);
          if (expanded.length === 0) {
            this.logger.debug?.('ActivityPub reconciliation expanded an empty followers collection', { recipientUri });
          }
        } else {
          const collection = await ctx.call(
            'activitypub.collection.get',
            { resourceUri: recipientUri, webId: actorUri || 'system' },
            { meta: { dataset } }
          );
          expanded = collectionItemUris(collection);
          if (expanded.length === 0) {
            this.logger.debug?.('ActivityPub reconciliation expanded an empty followers collection', { recipientUri });
          }
        }
        output.push(...expanded);
      }
      return [...new Set(output)];
    },

    async reconcileActivity(ctx, activity, dataset, senderFollowersSnapshot = null) {
      const blindSnapshot = typeof this.loadBlindRecipientSnapshot === 'function'
        ? await this.loadBlindRecipientSnapshot(activity)
        : null;
      const routingActivity = blindSnapshot ? { ...activity, ...blindSnapshot } : activity;
      const recipients = await ctx.call('activitypub.activity.getRecipients', { activity: routingActivity });
      const concreteRecipients = await this.expandConcreteRecipients(
        ctx,
        routingActivity,
        recipients,
        dataset,
        senderFollowersSnapshot
      );
      const localCandidateUris = concreteRecipients.filter(recipientUri => recipientUri.startsWith(this.settings.baseUri));
      const remoteRecipientUris = concreteRecipients.filter(recipientUri => !recipientUri.startsWith(this.settings.baseUri));
      const localRecipientAccounts = await this.findLocalAccountsByWebIds(ctx, localCandidateUris);
      const localRecipientUris = localCandidateUris.filter(recipientUri => localRecipientAccounts.has(recipientUri));

      if (remoteRecipientUris.length === 0) return null;

      return buildDeliveryPlanV1(ctx, {
        activity,
        localRecipientUris,
        remoteRecipientUris,
        localRecipientAccounts,
        podProvider: true
      });
    },

    async reconcileAccount(ctx, account) {
      const dataset = account.username;
      let activitiesScanned = 0;
      let handoffsRequeued = 0;
      let failures = 0;

      try {
        const outboxUri = await this.resolveLocalOutboxUri(ctx, account.webId, dataset);

        const cutoffMs = Date.now() - Math.max(60000, Number(this.settings.lookbackMs) || 900000);
        const cutoffPublished = new Date(cutoffMs).toISOString();
        const pageSize = Math.max(1, Math.min(1000, Math.floor(Number(this.settings.maxActivitiesPerAccount) || 50)));
        const senderFollowersSnapshot = { actorUri: account.webId, items: null };
        let activityCursor = null;
        let reachedCutoff = false;

        while (!reachedCutoff) {
          const { rows: page, nextCursor } = await this.listOutboxActivityPage(ctx, {
            outboxUri,
            dataset,
            cursor: activityCursor,
            limit: pageSize,
            cutoffPublished
          });
          if (page.length === 0) break;

          for (const row of page) {
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
              if (!Number.isFinite(publishedMs) || publishedMs < cutoffMs) {
                reachedCutoff = true;
                break;
              }

              const deliveryPlan = await this.reconcileActivity(ctx, activity, dataset, senderFollowersSnapshot);
              if (!deliveryPlan) continue;

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

          if (reachedCutoff || page.length < pageSize) break;
          if (
            !nextCursor ||
            (activityCursor &&
              nextCursor.published === activityCursor.published &&
              nextCursor.activityUri === activityCursor.activityUri)
          ) {
            failures += 1;
            this.logger.warn('ActivityPub delivery reconciliation outbox cursor failed to advance', {
              actorUri: account.webId,
              dataset
            });
            break;
          }
          activityCursor = nextCursor;
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