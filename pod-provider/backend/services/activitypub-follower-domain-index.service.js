'use strict';

const crypto = require('crypto');
const { getDatasetFromUri } = require('@semapps/ldp');
const { MIME_TYPES } = require('@semapps/mime-types');
const { retryWithBackoff } = require('../utils/backoff');

const APODS = 'http://activitypods.org/ns/core#';
const ENTRY_TYPE = 'apods:FollowerDomainIndexEntry';
const STATE_TYPE = 'apods:FollowerDomainIndexState';
const MAX_CONCURRENT_VALIDATIONS = 16;

function sparqlLiteral(value) {
  return JSON.stringify(String(value));
}

function normalizeHttpUri(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096) return null;
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeDomain(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.length > 253 || trimmed.includes('/') || trimmed.includes(':')) return null;
  try {
    const parsed = new URL(`https://${trimmed}/`);
    return parsed.hostname === trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

function domainForFollower(followerUri) {
  const normalized = normalizeHttpUri(followerUri);
  if (!normalized) return null;
  return new URL(normalized).hostname.toLowerCase();
}

module.exports = {
  name: 'activitypub.follower-domain-index',

  dependencies: ['activitypub.collection', 'triplestore'],

  created() {
    this.rebuilds = new Map();
    this.pendingMutations = new Map();
    this.dirtyCollections = new Set();
  },

  async started() {
    // Collection mutations and projection updates are separate operations. A
    // process may die after the authoritative collection write but before the
    // event projection is updated. Invalidate only the small readiness-marker
    // set on boot; individual follower collections are lazily reconciled on
    // their first FEP-8fcf domain query rather than scanning every account.
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
    getForDomain: {
      params: {
        collectionUri: { type: 'string', min: 1 },
        domain: { type: 'string', min: 1 }
      },
      async handler(ctx) {
        const collectionUri = normalizeHttpUri(ctx.params.collectionUri);
        const domain = normalizeDomain(ctx.params.domain);
        if (!collectionUri || !domain) return [];

        await this.ensureReady(ctx, collectionUri);

        const rows = await this.triQuery(
          ctx,
          `
            PREFIX apods: <${APODS}>
            SELECT ?entry ?followerUri
            WHERE {
              ?entry a ${ENTRY_TYPE} ;
                     apods:collectionUri ${sparqlLiteral(collectionUri)} ;
                     apods:domain ${sparqlLiteral(domain)} ;
                     apods:followerUri ?followerUri .
            }
          `
        );

        const candidates = (Array.isArray(rows) ? rows : [])
          .map(row => ({
            entry: this.readBinding(row, 'entry'),
            followerUri: this.readBinding(row, 'followerUri')
          }))
          .filter(row => row.entry && row.followerUri);

        // The projection is an acceleration structure, never membership
        // authority. Exact candidate membership checks are predicate/object ASK
        // operations and are bounded by the requested domain subset, not by the
        // actor's full follower population.
        const valid = [];
        const staleEntries = [];
        for (let offset = 0; offset < candidates.length; offset += MAX_CONCURRENT_VALIDATIONS) {
          const batch = candidates.slice(offset, offset + MAX_CONCURRENT_VALIDATIONS);
          const checked = await Promise.all(
            batch.map(async candidate => {
              const included = await ctx.call('activitypub.collection.includes', {
                collectionUri,
                itemUri: candidate.followerUri
              });
              return { ...candidate, included: included === true };
            })
          );
          for (const candidate of checked) {
            if (candidate.included) valid.push(candidate.followerUri);
            else staleEntries.push(candidate.entry);
          }
        }

        if (staleEntries.length > 0) {
          await this.deleteEntries(ctx, staleEntries).catch(error => {
            this.logger.debug('[FollowerDomainIndex] stale-entry cleanup deferred', {
              collectionUri,
              error: error instanceof Error ? error.message : String(error)
            });
          });
        }

        return [...new Set(valid)];
      }
    },

    rebuild: {
      params: {
        collectionUri: { type: 'string', min: 1 }
      },
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
      return `urn:activitypods:follower-domain-state:${digest}`;
    },

    entryUri(collectionUri, followerUri) {
      const digest = crypto
        .createHash('sha256')
        .update(collectionUri)
        .update('\u0000')
        .update(followerUri)
        .digest('hex');
      return `urn:activitypods:follower-domain-entry:${digest}`;
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

    async isReady(ctx, collectionUri) {
      if (this.dirtyCollections.has(collectionUri)) return false;
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
      return Array.isArray(rows) && rows.length > 0;
    },

    async ensureReady(ctx, collectionUri) {
      const active = this.rebuilds.get(collectionUri);
      if (active) return active;
      if (await this.isReady(ctx, collectionUri)) return;
      return this.rebuildCollection(ctx, collectionUri);
    },

    async rebuildCollection(ctx, collectionUri) {
      const active = this.rebuilds.get(collectionUri);
      if (active) return active;

      const promise = (async () => {
        const dataset = getDatasetFromUri(collectionUri);
        const rows = await ctx.call('triplestore.query', {
          query: `
            PREFIX as: <https://www.w3.org/ns/activitystreams#>
            SELECT DISTINCT ?followerUri
            WHERE {
              <${collectionUri}> as:items ?followerUri .
            }
          `,
          dataset,
          webId: 'system',
          accept: MIME_TYPES.JSON
        });

        const followers = (Array.isArray(rows) ? rows : [])
          .map(row => normalizeHttpUri(this.readBinding(row, 'followerUri')))
          .filter(Boolean);

        const stateUri = this.stateUri(collectionUri);
        const entryBlocks = followers
          .map(followerUri => {
            const domain = domainForFollower(followerUri);
            if (!domain) return null;
            const entryUri = this.entryUri(collectionUri, followerUri);
            return `<${entryUri}> a ${ENTRY_TYPE} ;\n` +
              `  apods:collectionUri ${sparqlLiteral(collectionUri)} ;\n` +
              `  apods:domain ${sparqlLiteral(domain)} ;\n` +
              `  apods:followerUri ${sparqlLiteral(followerUri)} .`;
          })
          .filter(Boolean)
          .join('\n');

        await this.triUpdate(
          ctx,
          `
            PREFIX apods: <${APODS}>
            DELETE {
              ?entry ?p ?o .
              <${stateUri}> ?stateP ?stateO .
            }
            INSERT {
              ${entryBlocks}
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

        // Apply mutations that happened after the authoritative snapshot was
        // read. Event handlers queue while this rebuild promise is registered.
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

        // Mutations can arrive while the marker write is awaiting Fuseki. They
        // are still queued because the rebuild remains registered; drain once
        // more before allowing reads through this process.
        await this.drainPendingMutations(ctx, collectionUri);
        this.dirtyCollections.delete(collectionUri);
        return followers.length;
      })();

      this.rebuilds.set(collectionUri, promise);
      try {
        return await promise;
      } catch (error) {
        this.dirtyCollections.add(collectionUri);
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

      let owner;
      try {
        owner = await ctx.call('activitypub.collection.getOwner', {
          collectionUri,
          collectionKey: 'followers'
        });
      } catch {
        return;
      }
      if (!owner) return;

      if (this.rebuilds.has(collectionUri)) {
        this.queueMutation(collectionUri, { operation, itemUri });
        return;
      }

      try {
        await this.applyMutation(ctx, operation, collectionUri, itemUri);
      } catch (error) {
        this.dirtyCollections.add(collectionUri);
        this.logger.warn('[FollowerDomainIndex] projection mutation failed; collection marked dirty', {
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

      const domain = domainForFollower(followerUri);
      if (!domain) return;
      await this.triUpdate(
        ctx,
        `
          PREFIX apods: <${APODS}>
          DELETE { <${entryUri}> ?p ?o . }
          INSERT {
            <${entryUri}> a ${ENTRY_TYPE} ;
              apods:collectionUri ${sparqlLiteral(collectionUri)} ;
              apods:domain ${sparqlLiteral(domain)} ;
              apods:followerUri ${sparqlLiteral(followerUri)} .
          }
          WHERE { OPTIONAL { <${entryUri}> ?p ?o . } }
        `
      );
    },

    async deleteEntries(ctx, entries) {
      if (!entries.length) return;
      const values = entries.map(entry => `<${entry}>`).join(' ');
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
};
