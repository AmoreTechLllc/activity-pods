const APODS = 'http://activitypods.org/ns/core#';
const INDEX_TYPE = 'apods:AtprotoIdentityBindingIndex';

module.exports = {
  name: 'internal-identity-projection',

  dependencies: ['identitybindings', 'triplestore'],

  actions: {
    getByCanonicalAccountId: {
      params: {
        canonicalAccountId: 'string|min:1'
      },
      async handler(ctx) {
        const binding = await this.lookupBinding(
          ctx,
          'identitybindings.getByCanonicalAccountId',
          {
            canonicalAccountId: String(ctx.params.canonicalAccountId).trim()
          }
        );

        return this.normalize(binding);
      }
    },

    getByDid: {
      params: {
        atprotoDid: 'string|min:1'
      },
      async handler(ctx) {
        const atprotoDid = String(ctx.params.atprotoDid).trim();
        const indexed = await this.lookupIndexedBinding(ctx, 'atprotoDid', atprotoDid);
        if (indexed) return this.normalize(indexed);

        // Compatibility fallback for legacy, missing or stale index state.
        const binding = await this.lookupBinding(ctx, 'identitybindings.getByDid', {
          atprotoDid
        });

        return this.normalize(binding);
      }
    },

    getByHandle: {
      params: {
        atprotoHandle: 'string|min:1'
      },
      async handler(ctx) {
        const atprotoHandle = String(ctx.params.atprotoHandle).trim().toLowerCase();
        const indexed = await this.lookupIndexedBinding(ctx, 'atprotoHandle', atprotoHandle);
        if (indexed) return this.normalize(indexed);

        // Exact indexed lookup is case-sensitive by design. Legacy bindings
        // that stored a non-normalized handle still retain the existing
        // case-insensitive identitybindings fallback.
        const binding = await this.lookupBinding(ctx, 'identitybindings.getByHandle', {
          atprotoHandle
        });

        return this.normalize(binding);
      }
    }
  },

  methods: {
    async lookupBinding(ctx, actionName, params) {
      try {
        return await ctx.call(actionName, params);
      } catch (error) {
        if (
          error &&
          (error.code === 404 ||
            error.type === 'NOT_FOUND' ||
            error.type === 'IDENTITY_BINDING_NOT_FOUND')
        ) {
          return null;
        }

        throw error;
      }
    },

    async lookupIndexedBinding(ctx, field, expectedValue) {
      const predicates = {
        atprotoDid: 'atprotoDid',
        atprotoHandle: 'atprotoHandle'
      };
      const predicate = predicates[field];
      if (!predicate) throw new Error(`Unsupported identity index field: ${field}`);

      try {
        const rows = await ctx.call('triplestore.query', {
          query: `
            PREFIX apods: <${APODS}>
            SELECT ?canonicalAccountId
            WHERE {
              ?binding apods:${predicate} ${JSON.stringify(String(expectedValue))} ;
                       a ${INDEX_TYPE} ;
                       apods:canonicalAccountId ?canonicalAccountId .
            }
            LIMIT 1
          `,
          dataset: 'settings',
          webId: 'system'
        });

        const canonicalAccountId = this.readQueryBinding(rows?.[0], 'canonicalAccountId');
        if (!canonicalAccountId) return null;

        const binding = await this.lookupBinding(ctx, 'identitybindings.getByCanonicalAccountId', {
          canonicalAccountId
        });
        if (!binding) return null;

        // The settings index is a performance projection, not identity authority.
        // A failed index sync may leave an old DID/handle pointing at an otherwise
        // valid canonical binding, so verify the authoritative LDP value before
        // accepting the index hit. A mismatch deliberately falls back to the
        // compatibility lookup rather than returning the wrong current identity.
        const normalizeLookupValue = value => {
          const normalized = String(value || '').trim();
          return field === 'atprotoHandle' ? normalized.toLowerCase() : normalized;
        };
        if (normalizeLookupValue(binding[field]) !== normalizeLookupValue(expectedValue)) {
          return null;
        }

        return binding;
      } catch (error) {
        // The LDP binding remains authoritative and the previous lookup path is
        // retained by callers. An unavailable/stale settings index must degrade
        // performance, not correctness.
        this.logger.debug('Exact identity index lookup failed; using compatibility fallback', {
          field,
          error: error instanceof Error ? error.message : String(error)
        });
        return null;
      }
    },

    readQueryBinding(row, key) {
      const value = row?.[key];
      if (typeof value === 'string') return value;
      if (value && typeof value === 'object' && typeof value.value === 'string') {
        return value.value;
      }
      return null;
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

        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt
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
