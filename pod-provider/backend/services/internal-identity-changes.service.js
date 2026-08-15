const { MoleculerError } = require('moleculer').Errors;
const {
  buildIncrementalIdentityBindingQuery,
  mapIdentityBindingRow,
  encodeCursor,
  parseCursor
} = require('../lib/identitybinding-index-query');

module.exports = {
  name: 'internal-identity-changes',

  dependencies: ['identitybindings'],

  actions: {
    listChanges: {
      params: {
        since: { type: 'string', optional: true },
        limit: { type: 'number', integer: true, positive: true, optional: true, convert: true }
      },
      async handler(ctx) {
        const limit = Math.max(1, Math.min(Number(ctx.params.limit) || 100, 500));
        const since = ctx.params.since || null;

        try {
          // Validate the opaque cursor before constructing the query so malformed
          // client input remains a 400 rather than silently falling back to a
          // full compatibility scan.
          if (since) parseCursor(since);

          const rows = await ctx.call('triplestore.query', {
            query: buildIncrementalIdentityBindingQuery({ since, limit }),
            dataset: 'settings',
            webId: 'system'
          });
          const items = (rows || [])
            .map(mapIdentityBindingRow)
            .filter(binding => binding?.canonicalAccountId && binding?.updatedAt);
          const last = items[items.length - 1];

          return {
            items: items.map(binding => this.normalize(binding)),
            nextCursor: last ? encodeCursor(last) : since
          };
        } catch (err) {
          if (err?.message === 'Invalid identity binding cursor') {
            throw new MoleculerError('Invalid cursor', 400, 'INVALID_CURSOR');
          }

          // Preserve the existing identitybindings.list implementation as a
          // compatibility fallback for deployments whose triplestore does not
          // expose the settings index query path. The optimized path is the
          // normal provider-scale path; fallback semantics are unchanged.
          this.logger.warn('Bounded identity index query failed, falling back', {
            error: err.message
          });
          const result = await ctx.call('identitybindings.list', {
            since,
            limit
          });

          return {
            items: Array.isArray(result?.items)
              ? result.items.map(binding => this.normalize(binding))
              : [],
            nextCursor:
              typeof result?.nextCursor === 'string' || result?.nextCursor === null
                ? result.nextCursor
                : since
          };
        }
      }
    }
  },

  methods: {
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
