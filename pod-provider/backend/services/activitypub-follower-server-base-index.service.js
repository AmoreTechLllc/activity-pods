'use strict';

const crypto = require('crypto');
const { getDatasetFromUri } = require('@semapps/ldp');
const { MIME_TYPES } = require('@semapps/mime-types');
const { retryWithBackoff } = require('../utils/backoff');

const APODS = 'http://activitypods.org/ns/core#';
const ENTRY_TYPE = 'apods:FollowerServerBaseIndexEntry';
const STATE_TYPE = 'apods:FollowerServerBaseIndexState';
const MEMBERSHIP_QUERY_MAX_ITEMS = 500;
const MEMBERSHIP_VALUES_MAX_CHARS = 64 * 1024;
const REBUILD_PAGE_SIZE = 500;
const REBUILD_INSERT_MAX_ITEMS = 250;
const REBUILD_INSERT_MAX_CHARS = 64 * 1024;
const MAX_HTTP_URI_LENGTH = 4096;

function sparqlLiteral(value) {
  return JSON.stringify(String(value));
}

function normalizeHttpUri(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_HTTP_URI_LENGTH) return null;
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    const normalized = parsed.toString();
    return normalized.length <= MAX_HTTP_URI_LENGTH ? normalized : null;
  } catch {
    return null;
  }
}

function normalizeServerBaseUri(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_HTTP_URI_LENGTH) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    if (parsed.search || parsed.hash || parsed.pathname !== '/') return null;
    return `${parsed.origin}/`;
  } catch {
    return null;
  }
}

function serverBaseUriForFollower(followerUri) {
  const normalized = normalizeHttpUri(followerUri);
  if (!normalized) return null;
  const parsed = new URL(normalized);
  return `${parsed.origin}/`;
}

function chunkByRenderedSize(items, render, maxItems, maxChars) {
  const batches = [];
  let batch = [];
  let chars = 0;

  for (const item of items) {
    const rendered = render(item);
    const renderedLength = rendered.length + 1;
    if (batch.length > 0 && (batch.length >= maxItems || chars + renderedLength > maxChars)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(item);
    chars += renderedLength;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function chunkSparqlIris(items) {
  return chunkByRenderedSize(
    items,
    item => `<${item}>`,
    MEMBERSHIP_QUERY_MAX_ITEMS,
    MEMBERSHIP_VALUES_MAX_CHARS
  );
}

module.exports = {
  name: 'activitypub.follower-server-base-index',
  dependencies: ['activitypub.collection', 'triplestore'],

  created() {
    this.rebuilds = new Map();
    this.pendingMutations = new Map();
    this.dirtyCollections = new Set();
    this.readyCollections = new Set();
  },

  async started() {
    this.readyCollections.clear();
    await this.triUpdate(
      this.broker,
      `
        PREFIX apods: <${APODS}>
        DELETE { ?state apods:ready true . }
        WHERE {
          ?state a ${STATE_TYPE} ;
                 apods:ready true .
        }
      `
    );
  },

  events: {
    'activitypub.collection.added': {
      async handler(ctx) {
        await this.handleCollectionMutation(ctx, 'add', ctx.params?.collectionUri, ctx.params?.itemUri);
      }
    },
    'activitypub.collection.removed': {
      async handler(ctx) {
        await this.handleCollectionMutation(ctx, 'remove', ctx.params?.collectionUri, ctx.params?.itemUri);
      }
    }
  },

  actions: {
    getForServerBaseUri: {
      params: {
        collectionUri: { type: 'string', min: 1 },
        serverBaseUri: { type: 'string', min: 1 }
      },
      async handler(ctx) {
        const collectionUri = normalizeHttpUri(ctx.params.collectionUri);
        const serverBaseUri = normalizeServerBaseUri(ctx.params.serverBaseUri);
        if (!collectionUri || !serverBaseUri) return [];

        await this.ensureReady(ctx, collectionUri);

        const rows = await this.triQuery(
          ctx,
          `
            PREFIX apods: <${APODS}>
            SELECT ?entry ?followerUri
            WHERE {
              ?entry a ${ENTRY_TYPE} ;
                     apods:collectionUri ${sparqlLiteral(collectionUri)} ;
                     apods:serverBaseUri ${sparqlLiteral(serverBaseUri)} ;
                     apods:followerUri ?followerUri .
            }
          `
        );

        const candidates = (Array.isArray(rows) ? rows : [])
          .map(row => ({
            entry: this.readBinding(row, 'entry'),
            followerUri: normalizeHttpUri(this.readBinding(row, 'followerUri'))
          }))
          .filter(row => row.entry && row.followerUri);

        const authoritativeMembers = await this.queryAuthoritativeMembers(
          ctx,
          collectionUri,
          [...new Set(candidates.map(candidate => candidate.followerUri))]
        );
        const valid = [];
        const staleEntries = [];
        for (const candidate of candidates) {
          if (
            authoritativeMembers.has(candidate.followerUri) &&
            serverBaseUriForFollower(candidate.followerUri) === serverBaseUri
          ) {
            valid.push(candidate.followerUri);
          } else {
            staleEntries.push(candidate.entry);
          }
        }

        if (staleEntries.length > 0) {
          await this.deleteEntries(ctx, staleEntries).catch(error => {
            this.logger.debug('[FollowerServerBaseIndex] stale-entry cleanup deferred', {
              collectionUri,
              error: error instanceof Error ? error.message : String(error)
            });
          });
        }

        return [...new Set(valid)];
      }
    },

    rebuild: {
      params: { collectionUri: { type: 'string', min: 1 } },
      async handler(ctx) {
        const collectionUri = normalizeHttpUri(ctx.params.collectionUri);
        if (!collectionUri) return { rebuilt: false, count: 0 };
        const count = await this.rebuildCollection(ctx, collectionUri);
        return { rebuilt: true, count };
      }
    }
  },

  methods: {
    stateUri(collectionUri) {
      const digest = crypto.createHash('sha256').update(collectionUri).digest('hex').slice(0, 32);
      return `urn:activitypods:follower-server-base-state:${digest}`;
    },

    entryUri(collectionUri, followerUri) {
      const digest = crypto
        .createHash('sha256')
        .update(collectionUri)
        .update('\u0000')
        .update(followerUri)
        .digest('hex');
      return `urn:activitypods:follower-server-base-entry:${digest}`;
    },

    readBinding(row, key) {
      const value = row?.[key];
      if (typeof value === 'string' || typeof value === 'boolean') return value;
      if (value && typeof value === 'object' && typeof value.value === 'string') return value.value;
      return null;
    },

    async triQuery(ctx, query) {
      return retryWithBackoff(
        () => ctx.call('triplestore.query', { query, dataset: 'settings', webId: 'system', accept: MIME_TYPES.JSON }),
        {
          maxRetries: 2,
          baseDelayMs: 50,
          maxDelayMs: 500,
          retryIf: error => Number(error?.code) === 429 || Number(error?.code) >= 500
        }
      );
    },

    async triUpdate(ctx, query) {
      return retryWithBackoff(
        () => ctx.call('triplestore.update', { query, dataset: 'settings', webId: 'system' }),
        {
          maxRetries: 2,
          baseDelayMs: 50,
          maxDelayMs: 500,
          retryIf: error => Number(error?.code) === 429 || Number(error?.code) >= 500
        }
      );
    },

    async queryAuthoritativeMembers(ctx, collectionUri, followerUris) {
      if (followerUris.length === 0) return new Set();
      const dataset = getDatasetFromUri(collectionUri);
      const authoritativeMembers = new Set();

      for (const batch of chunkSparqlIris(followerUris)) {
        const values = batch.map(followerUri => `<${followerUri}>`).join(' ');
        const rows = await retryWithBackoff(
          () =>
            ctx.call('triplestore.query', {
              query: `
                PREFIX as: <https://www.w3.org/ns/activitystreams#>
                SELECT DISTINCT ?followerUri
                WHERE {
                  VALUES ?followerUri { ${values} }
                  <${collectionUri}> as:items ?followerUri .
                }
              `,
              dataset,
              webId: 'system',
              accept: MIME_TYPES.JSON
            }),
          {
            maxRetries: 2,
            baseDelayMs: 50,
            maxDelayMs: 500,
            retryIf: error => Number(error?.code) === 429 || Number(error?.code) >= 500
          }
        );
        for (const row of Array.isArray(rows) ? rows : []) {
          const followerUri = normalizeHttpUri(this.readBinding(row, 'followerUri'));
          if (followerUri) authoritativeMembers.add(followerUri);
        }
      }
      return authoritativeMembers;
    },

    async isReady(ctx, collectionUri) {
      if (this.dirtyCollections.has(collectionUri)) return false;
      if (this.readyCollections.has(collectionUri)) return true;
      const rows = await this.triQuery(
        ctx,
        `
          PREFIX apods: <${APODS}>
          SELECT ?ready
          WHERE {
            <${this.stateUri(collectionUri)}> a ${STATE_TYPE} ;
              apods:ready ?ready .
            FILTER(?ready = true)
          }
          LIMIT 1
        `
      );
      const ready = Array.isArray(rows) && rows.length > 0;
      if (ready) this.readyCollections.add(collectionUri);
      return ready;
    },

    async ensureReady(ctx, collectionUri) {
      const active = this.rebuilds.get(collectionUri);
      if (active) return active;
      if (await this.isReady(ctx, collectionUri)) return;
      return this.rebuildCollection(ctx, collectionUri);
    },

    async queryFollowerPage(ctx, collectionUri, dataset, cursor) {
      const cursorFilter = cursor
        ? `FILTER(STR(?followerUri) > ${sparqlLiteral(cursor)})`
        : '';
      return retryWithBackoff(
        () =>
          ctx.call('triplestore.query', {
            query: `
              PREFIX as: <https://www.w3.org/ns/activitystreams#>
              SELECT DISTINCT ?followerUri
              WHERE {
                <${collectionUri}> as:items ?followerUri .
                FILTER(isIRI(?followerUri))
                ${cursorFilter}
              }
              ORDER BY STR(?followerUri)
              LIMIT ${REBUILD_PAGE_SIZE}
            `,
            dataset,
            webId: 'system',
            accept: MIME_TYPES.JSON
          }),
        {
          maxRetries: 2,
          baseDelayMs: 50,
          maxDelayMs: 500,
          retryIf: error => Number(error?.code) === 429 || Number(error?.code) >= 500
        }
      );
    },

    renderProjectionEntry(collectionUri, followerUri) {
      const serverBaseUri = serverBaseUriForFollower(followerUri);
      if (!serverBaseUri) return null;
      const entryUri = this.entryUri(collectionUri, followerUri);
      return `<${entryUri}> a ${ENTRY_TYPE} ;\n` +
        `  apods:collectionUri ${sparqlLiteral(collectionUri)} ;\n` +
        `  apods:serverBaseUri ${sparqlLiteral(serverBaseUri)} ;\n` +
        `  apods:followerUri ${sparqlLiteral(followerUri)} .`;
    },

    async clearCollectionProjection(ctx, collectionUri) {
      const stateUri = this.stateUri(collectionUri);
      await this.triUpdate(
        ctx,
        `
          PREFIX apods: <${APODS}>
          DELETE {
            ?entry ?p ?o .
            <${stateUri}> ?stateP ?stateO .
          }
          WHERE {
            OPTIONAL {
              ?entry a ${ENTRY_TYPE} ;
                     apods:collectionUri ${sparqlLiteral(collectionUri)} ;
                     ?p ?o .
            }
            OPTIONAL { <${stateUri}> ?stateP ?stateO . }
          }
        `
      );
    },

    async insertProjectionEntries(ctx, collectionUri, followerUris) {
      const entries = followerUris
        .map(followerUri => ({ followerUri, block: this.renderProjectionEntry(collectionUri, followerUri) }))
        .filter(entry => entry.block);

      const batches = chunkByRenderedSize(
        entries,
        entry => entry.block,
        REBUILD_INSERT_MAX_ITEMS,
        REBUILD_INSERT_MAX_CHARS
      );
      for (const batch of batches) {
        const blocks = batch.map(entry => entry.block).join('\n');
        await this.triUpdate(
          ctx,
          `
            PREFIX apods: <${APODS}>
            INSERT DATA {
              ${blocks}
            }
          `
        );
      }
      return entries.length;
    },

    async rebuildCollection(ctx, collectionUri) {
      const active = this.rebuilds.get(collectionUri);
      if (active) return active;

      const promise = (async () => {
        const dataset = getDatasetFromUri(collectionUri);
        const stateUri = this.stateUri(collectionUri);
        let cursor = null;
        let projectedCount = 0;

        this.readyCollections.delete(collectionUri);
        await this.clearCollectionProjection(ctx, collectionUri);

        for (;;) {
          const rows = await this.queryFollowerPage(ctx, collectionUri, dataset, cursor);
          const pageRows = Array.isArray(rows) ? rows : [];
          if (pageRows.length === 0) break;

          const rawUris = pageRows.map(row => this.readBinding(row, 'followerUri')).filter(Boolean);
          if (rawUris.length === 0) {
            throw new Error(`Follower server-base projection page for ${collectionUri} contained no usable cursor binding`);
          }

          const nextCursor = rawUris[rawUris.length - 1];
          if (cursor && nextCursor <= cursor) {
            throw new Error(`Follower server-base projection cursor did not advance for ${collectionUri}`);
          }

          const followers = rawUris.map(normalizeHttpUri).filter(Boolean);
          projectedCount += await this.insertProjectionEntries(ctx, collectionUri, followers);
          cursor = nextCursor;

          if (pageRows.length < REBUILD_PAGE_SIZE) break;
        }

        await this.drainPendingMutations(ctx, collectionUri);
        await this.triUpdate(
          ctx,
          `
            PREFIX apods: <${APODS}>
            DELETE { <${stateUri}> ?p ?o . }
            INSERT {
              <${stateUri}> a ${STATE_TYPE} ;
                apods:collectionUri ${sparqlLiteral(collectionUri)} ;
                apods:ready true .
            }
            WHERE { OPTIONAL { <${stateUri}> ?p ?o . } }
          `
        );
        await this.drainPendingMutations(ctx, collectionUri);
        this.dirtyCollections.delete(collectionUri);
        this.readyCollections.add(collectionUri);
        return projectedCount;
      })();

      this.rebuilds.set(collectionUri, promise);
      try {
        return await promise;
      } catch (error) {
        this.dirtyCollections.add(collectionUri);
        this.readyCollections.delete(collectionUri);
        throw error;
      } finally {
        this.rebuilds.delete(collectionUri);
      }
    },

    queueMutation(collectionUri, mutation) {
      const queue = this.pendingMutations.get(collectionUri) || [];
      queue.push(mutation);
      this.pendingMutations.set(collectionUri, queue);
    },

    async drainPendingMutations(ctx, collectionUri) {
      while (true) {
        const queue = this.pendingMutations.get(collectionUri) || [];
        if (queue.length === 0) {
          this.pendingMutations.delete(collectionUri);
          return;
        }
        this.pendingMutations.set(collectionUri, []);
        for (const mutation of queue) {
          await this.applyMutation(ctx, mutation.operation, collectionUri, mutation.itemUri);
        }
      }
    },

    async handleCollectionMutation(ctx, operation, collectionUriValue, itemUriValue) {
      const collectionUri = normalizeHttpUri(collectionUriValue);
      const itemUri = normalizeHttpUri(itemUriValue);
      if (!collectionUri || !itemUri) return;

      if (this.rebuilds.has(collectionUri)) {
        this.queueMutation(collectionUri, { operation, itemUri });
        return;
      }

      // Stay completely dormant for collections whose exact FEP index has never
      // been requested in this process. The first v2 query will rebuild from the
      // authoritative collection, so unsupported/non-FEP peers create no steady
      // mutation overhead here.
      if (!this.readyCollections.has(collectionUri)) return;

      let owner;
      try {
        owner = await ctx.call('activitypub.collection.getOwner', { collectionUri, collectionKey: 'followers' });
      } catch {
        return;
      }
      if (!owner) return;

      try {
        await this.applyMutation(ctx, operation, collectionUri, itemUri);
      } catch (error) {
        this.dirtyCollections.add(collectionUri);
        this.readyCollections.delete(collectionUri);
        this.logger.warn('[FollowerServerBaseIndex] projection mutation failed; collection marked dirty', {
          collectionUri,
          operation,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    },

    async applyMutation(ctx, operation, collectionUri, followerUri) {
      const entryUri = this.entryUri(collectionUri, followerUri);
      if (operation === 'remove') {
        await this.triUpdate(ctx, `DELETE WHERE { <${entryUri}> ?p ?o . }`);
        return;
      }
      const serverBaseUri = serverBaseUriForFollower(followerUri);
      if (!serverBaseUri) return;
      await this.triUpdate(
        ctx,
        `
          PREFIX apods: <${APODS}>
          DELETE { <${entryUri}> ?p ?o . }
          INSERT {
            <${entryUri}> a ${ENTRY_TYPE} ;
              apods:collectionUri ${sparqlLiteral(collectionUri)} ;
              apods:serverBaseUri ${sparqlLiteral(serverBaseUri)} ;
              apods:followerUri ${sparqlLiteral(followerUri)} .
          }
          WHERE { OPTIONAL { <${entryUri}> ?p ?o . } }
        `
      );
    },

    async deleteEntries(ctx, entries) {
      if (!entries.length) return;
      for (const batch of chunkSparqlIris(entries)) {
        const values = batch.map(entry => `<${entry}>`).join(' ');
        await this.triUpdate(
          ctx,
          `
            DELETE { ?entry ?p ?o . }
            WHERE {
              VALUES ?entry { ${values} }
              ?entry ?p ?o .
            }
          `
        );
      }
    }
  }
};
