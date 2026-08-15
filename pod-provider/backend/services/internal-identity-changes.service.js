const { MoleculerError } = require('moleculer').Errors;

const APODS = 'http://activitypods.org/ns/core#';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_CONCURRENT_READS = 16;

module.exports = {
  name: 'internal-identity-changes',

  dependencies: ['identitybindings', 'triplestore'],

  actions: {
    listChanges: {
      params: {
        since: { type: 'string', optional: true },
        limit: { type: 'number', integer: true, positive: true, optional: true, convert: true }
      },
      async handler(ctx) {
        const limit = Math.max(1, Math.min(Number(ctx.params.limit) || DEFAULT_LIMIT, MAX_LIMIT));
        const cursor = this.parseCursor(ctx.params.since || null);
        const selectors = await this.selectChangePage(ctx, cursor, limit);
        const items = [];

        for (let offset = 0; offset < selectors.length; offset += MAX_CONCURRENT_READS) {
          const batch = selectors.slice(offset, offset + MAX_CONCURRENT_READS);
          const results = await Promise.all(
            batch.map(async selector => {
              const binding = await ctx.call(
                'identitybindings.getByCanonicalAccountId',
                { canonicalAccountId: selector.canonicalAccountId },
                { parentCtx: ctx }
              );
              return binding ? this.normalize(binding) : null;
            })
          );
          items.push(...results.filter(Boolean));
        }

        const lastSelector = selectors[selectors.length - 1] || null;
        return {
          items,
          nextCursor: lastSelector ? this.encodeCursor(lastSelector) : ctx.params.since || null
        };
      }
    }
  },

  methods: {
    parseCursor(value) {
      if (!value) return null;
      try {
        const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
        if (
          typeof parsed?.updatedAt !== 'string' ||
          !parsed.updatedAt ||
          typeof parsed?.canonicalAccountId !== 'string' ||
          !parsed.canonicalAccountId
        ) {
          throw new Error('invalid cursor payload');
        }
        return parsed;
      } catch {
        throw new MoleculerError('Invalid cursor', 400, 'INVALID_CURSOR');
      }
    },

    encodeCursor(selector) {
      return Buffer.from(
        JSON.stringify({
          updatedAt: selector.updatedAt,
          canonicalAccountId: selector.canonicalAccountId
        }),
        'utf8'
      ).toString('base64url');
    },

    sparqlLiteral(value) {
      return JSON.stringify(String(value));
    },

    readBinding(row, key) {
      const value = row?.[key];
      if (typeof value === 'string') return value;
      if (value && typeof value === 'object' && typeof value.value === 'string') return value.value;
      return null;
    },

    async selectChangePage(ctx, cursor, limit) {
      const cursorFilter = cursor
        ? `FILTER(\n              ?updatedAt > ${this.sparqlLiteral(cursor.updatedAt)} ||\n              (?updatedAt = ${this.sparqlLiteral(cursor.updatedAt)} &&\n               ?canonicalAccountId > ${this.sparqlLiteral(cursor.canonicalAccountId)})\n            )`
        : '';

      const rows = await ctx.call('triplestore.query', {
        query: `
          PREFIX apods: <${APODS}>
          SELECT ?canonicalAccountId ?updatedAt
          WHERE {
            ?binding a apods:AtprotoIdentityBindingIndex ;
                     apods:updatedAt ?updatedAt ;
                     apods:canonicalAccountId ?canonicalAccountId .
            ${cursorFilter}
          }
          ORDER BY ?updatedAt ?canonicalAccountId
          LIMIT ${limit}
        `,
        dataset: 'settings',
        webId: 'system'
      });

      return (Array.isArray(rows) ? rows : [])
        .map(row => ({
          canonicalAccountId: this.readBinding(row, 'canonicalAccountId'),
          updatedAt: this.readBinding(row, 'updatedAt')
        }))
        .filter(entry => entry.canonicalAccountId && entry.updatedAt);
    },

    normalize(binding) {
      if (!binding) return null;

      return {
        canonicalAccountId: binding.canonicalAccountId,
        webId: binding.webId,
        activityPubActorId: binding.activityPubActorId || binding.webId || null,
        activityPubHandle: binding.activityPubHandle || null,
        atprotoDid: binding.atprotoDid,
        atprotoHandle: binding.atprotoHandle,
        atprotoSource: binding.atprotoSource || 'local',
        atprotoManaged:
          typeof binding.atprotoManaged === 'boolean' ? binding.atprotoManaged : true,
        atprotoPdsUrl: binding.atprotoPdsUrl || null,
        atSigningKeyRef: binding.atSigningKeyRef,
        atRotationKeyRef: binding.atRotationKeyRef,
        status: this.normalizeStatus(binding.status),
        repo: {
          initialized: Boolean(binding.repoInitialized),
          rootCid: binding.repoRootCid || null,
          rev: binding.repoRev || null
        },
        createdAt: binding.createdAt || null,
        updatedAt: binding.updatedAt || null
      };
    },

    normalizeStatus(status) {
      if (status === 'active') return 'active';
      if (status === 'suspended') return 'disabled';
      if (status === 'deactivated') return 'disabled';
      return 'pending';
    }
  }
};
