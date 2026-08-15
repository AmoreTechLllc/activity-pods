const { MoleculerError } = require('moleculer').Errors;

const APODS = 'http://activitypods.org/ns/core#';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const CURSOR_VERSION = 2;

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

        // Existing opaque cursors were created with JavaScript localeCompare for
        // equal timestamps. Fuseki's RDF lexical ordering is not equivalent for
        // all valid account IDs, so legacy cursors must remain on the old path.
        // New drains (no cursor) and v2 cursors use the bounded SPARQL page.
        if (cursor && cursor.version !== CURSOR_VERSION) {
          const legacy = await ctx.call(
            'identitybindings.list',
            { since: ctx.params.since || null, limit },
            { parentCtx: ctx }
          );
          return {
            items: Array.isArray(legacy?.items) ? legacy.items.map(binding => this.normalize(binding)) : [],
            nextCursor:
              typeof legacy?.nextCursor === 'string' || legacy?.nextCursor === null
                ? legacy.nextCursor
                : ctx.params.since || null
          };
        }

        const rows = await this.selectChangePage(ctx, cursor, limit);
        const items = rows.map(row => this.normalize(row));
        const last = rows[rows.length - 1] || null;

        return {
          items,
          nextCursor: last ? this.encodeCursor(last) : ctx.params.since || null
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
        return {
          version: parsed.v === CURSOR_VERSION ? CURSOR_VERSION : 1,
          updatedAt: parsed.updatedAt,
          canonicalAccountId: parsed.canonicalAccountId
        };
      } catch {
        throw new MoleculerError('Invalid cursor', 400, 'INVALID_CURSOR');
      }
    },

    encodeCursor(entry) {
      return Buffer.from(
        JSON.stringify({
          v: CURSOR_VERSION,
          updatedAt: entry.updatedAt,
          canonicalAccountId: entry.canonicalAccountId
        }),
        'utf8'
      ).toString('base64url');
    },

    sparqlLiteral(value) {
      return JSON.stringify(String(value));
    },

    readBinding(row, key) {
      const value = row?.[key];
      if (typeof value === 'string' || typeof value === 'boolean') return value;
      if (value && typeof value === 'object' && typeof value.value === 'string') return value.value;
      return null;
    },

    coerceBoolean(value) {
      if (typeof value === 'boolean') return value;
      const normalized = String(value ?? '').trim().toLowerCase();
      if (normalized === 'true' || normalized === '1') return true;
      if (normalized === 'false' || normalized === '0') return false;
      return null;
    },

    async selectChangePage(ctx, cursor, limit) {
      const cursorFilter = cursor
        ? `FILTER(\n              ?updatedAt > ${this.sparqlLiteral(cursor.updatedAt)} ||\n              (?updatedAt = ${this.sparqlLiteral(cursor.updatedAt)} &&\n               ?canonicalAccountId > ${this.sparqlLiteral(cursor.canonicalAccountId)})\n            )`
        : '';

      const rows = await ctx.call('triplestore.query', {
        query: `
          PREFIX apods: <${APODS}>
          SELECT ?canonicalAccountId ?webId ?activityPubActorId ?activityPubHandle
                 ?atprotoDid ?atprotoHandle ?atprotoSource ?atprotoManaged ?atprotoPdsUrl
                 ?atSigningKeyRef ?atRotationKeyRef ?status
                 ?repoInitialized ?repoRootCid ?repoRev ?createdAt ?updatedAt
          WHERE {
            ?binding a apods:AtprotoIdentityBindingIndex ;
                     apods:updatedAt ?updatedAt ;
                     apods:canonicalAccountId ?canonicalAccountId .
            OPTIONAL { ?binding apods:webId ?webId . }
            OPTIONAL { ?binding apods:activityPubActorId ?activityPubActorId . }
            OPTIONAL { ?binding apods:activityPubHandle ?activityPubHandle . }
            OPTIONAL { ?binding apods:atprotoDid ?atprotoDid . }
            OPTIONAL { ?binding apods:atprotoHandle ?atprotoHandle . }
            OPTIONAL { ?binding apods:atprotoSource ?atprotoSource . }
            OPTIONAL { ?binding apods:atprotoManaged ?atprotoManaged . }
            OPTIONAL { ?binding apods:atprotoPdsUrl ?atprotoPdsUrl . }
            OPTIONAL { ?binding apods:atSigningKeyRef ?atSigningKeyRef . }
            OPTIONAL { ?binding apods:atRotationKeyRef ?atRotationKeyRef . }
            OPTIONAL { ?binding apods:status ?status . }
            OPTIONAL { ?binding apods:repoInitialized ?repoInitialized . }
            OPTIONAL { ?binding apods:repoRootCid ?repoRootCid . }
            OPTIONAL { ?binding apods:repoRev ?repoRev . }
            OPTIONAL { ?binding apods:createdAt ?createdAt . }
            ${cursorFilter}
          }
          ORDER BY ?updatedAt ?canonicalAccountId
          LIMIT ${limit}
        `,
        dataset: 'settings',
        webId: 'system'
      });

      // The settings index is a coherent snapshot written from the saved LDP DTO.
      // Returning that bounded snapshot keeps item fields and the cursor on the
      // same ordering key and avoids an LDP re-read race between selection and
      // emission. Normal point lookups still revalidate against authoritative LDP.
      return (Array.isArray(rows) ? rows : [])
        .map(row => ({
          canonicalAccountId: this.readBinding(row, 'canonicalAccountId'),
          webId: this.readBinding(row, 'webId'),
          activityPubActorId: this.readBinding(row, 'activityPubActorId'),
          activityPubHandle: this.readBinding(row, 'activityPubHandle'),
          atprotoDid: this.readBinding(row, 'atprotoDid'),
          atprotoHandle: this.readBinding(row, 'atprotoHandle'),
          atprotoSource: this.readBinding(row, 'atprotoSource') || 'local',
          atprotoManaged: this.coerceBoolean(this.readBinding(row, 'atprotoManaged')) ?? true,
          atprotoPdsUrl: this.readBinding(row, 'atprotoPdsUrl'),
          atSigningKeyRef: this.readBinding(row, 'atSigningKeyRef'),
          atRotationKeyRef: this.readBinding(row, 'atRotationKeyRef'),
          status: this.readBinding(row, 'status'),
          repoInitialized: this.coerceBoolean(this.readBinding(row, 'repoInitialized')) ?? false,
          repoRootCid: this.readBinding(row, 'repoRootCid'),
          repoRev: this.readBinding(row, 'repoRev'),
          createdAt: this.readBinding(row, 'createdAt'),
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
