'use strict';

const crypto = require('crypto');
const { Errors: WebErrors } = require('moleculer-web');

const MAX_PARTIAL_FOLLOWERS = 10_000;
const MAX_PARTIAL_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_HTTP_URI_LENGTH = 4096;
const EMPTY_RESPONSE_BYTES = Buffer.byteLength(JSON.stringify({ followers: [] }), 'utf8');

module.exports = {
  name: 'internal-followers-sync-v2-api',

  dependencies: ['api', 'activitypub.actor', 'activitypub.follower-domain-index', 'auth.account'],

  settings: {
    auth: {
      bearerToken: process.env.ACTIVITYPODS_TOKEN || process.env.INTERNAL_API_TOKEN || process.env.SIDECAR_TOKEN || ''
    },
    routePath: '/api/internal/followers-sync-v2'
  },

  async started() {
    const bearerToken = this.settings.auth.bearerToken;
    if (!bearerToken) {
      this.logger.warn('[FollowersSyncV2Api] No internal bearer token configured; all requests will be rejected');
    }

    await this.broker.call('api.addRoute', {
      route: {
        name: 'followers-sync-v2-internal',
        path: this.settings.routePath,
        authorization: false,
        authentication: false,
        onBeforeCall: (ctx, route, req) => {
          const authHeader = (req.headers.authorization || req.headers.Authorization || '').trim();
          const token = this.parseBearerToken(authHeader);
          if (!this.safeTokenEquals(bearerToken, token)) {
            throw new WebErrors.UnAuthorizedError(WebErrors.ERR_INVALID_TOKEN, null, 'Unauthorized');
          }
          ctx.meta.$responseHeaders = {
            ...(ctx.meta.$responseHeaders || {}),
            'Cache-Control': 'no-store',
            Pragma: 'no-cache',
            'X-Content-Type-Options': 'nosniff'
          };
        },
        aliases: {
          'GET /partial-collection': 'internal-followers-sync-v2-api.getPartialCollection'
        }
      },
      toBottom: false
    });

    this.logger.info('[FollowersSyncV2Api] Internal route registered: /api/internal/followers-sync-v2/partial-collection');
  },

  actions: {
    getPartialCollection: {
      async handler(ctx) {
        const actorIdentifier = String(
          ctx.params?.actorIdentifier ?? ctx.meta.queryString?.actorIdentifier ?? ''
        ).trim();
        const requestedBaseUri = String(ctx.params?.baseUri ?? ctx.meta.queryString?.baseUri ?? '').trim();

        if (!actorIdentifier) {
          ctx.meta.$statusCode = 400;
          return { error: 'invalid_request', message: 'actorIdentifier is required' };
        }

        const baseUri = this.normalizeServerBaseUri(requestedBaseUri);
        if (!baseUri) {
          ctx.meta.$statusCode = 400;
          return {
            error: 'invalid_request',
            message: 'baseUri must be a credential-free HTTP(S) server base URI with root path'
          };
        }

        const actor = await this.findActorByIdentifier(ctx, actorIdentifier);
        if (!actor) {
          ctx.meta.$statusCode = 404;
          return { error: 'not_found', message: `Actor not found: ${actorIdentifier}` };
        }

        if (!actor.followers) {
          ctx.meta.$statusCode = 200;
          return { followers: [] };
        }

        const domain = new URL(baseUri).hostname.toLowerCase();
        let hostnameCandidates;
        try {
          hostnameCandidates = await ctx.call('activitypub.follower-domain-index.getForDomain', {
            collectionUri: actor.followers,
            domain
          });
        } catch (err) {
          this.logger.error('[FollowersSyncV2Api] partial collection projection failed', {
            actorIdentifier,
            baseUri,
            error: err.message
          });
          ctx.meta.$statusCode = 500;
          return { error: 'internal_error', message: 'Failed to query follower projection' };
        }

        if (!Array.isArray(hostnameCandidates)) {
          ctx.meta.$statusCode = 500;
          return { error: 'internal_error', message: 'Follower projection returned invalid data' };
        }

        const followers = [];
        const seen = new Set();
        let responseBytes = EMPTY_RESPONSE_BYTES;
        for (const candidate of hostnameCandidates) {
          const candidateBaseUri = this.serverBaseUriForActor(candidate);
          if (candidateBaseUri === null) {
            ctx.meta.$statusCode = 500;
            return { error: 'internal_error', message: 'Follower projection returned an invalid actor URI' };
          }
          if (candidateBaseUri !== baseUri || seen.has(candidate)) continue;

          const encodedCandidateBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
          const nextResponseBytes = responseBytes + encodedCandidateBytes + (followers.length > 0 ? 1 : 0);
          if (nextResponseBytes > MAX_PARTIAL_RESPONSE_BYTES) {
            ctx.meta.$statusCode = 503;
            return {
              error: 'collection_too_large',
              message: `Partial followers response exceeds ${MAX_PARTIAL_RESPONSE_BYTES} bytes`
            };
          }

          seen.add(candidate);
          followers.push(candidate);
          responseBytes = nextResponseBytes;
          if (followers.length > MAX_PARTIAL_FOLLOWERS) {
            ctx.meta.$statusCode = 503;
            return {
              error: 'collection_too_large',
              message: `Partial followers collection exceeds ${MAX_PARTIAL_FOLLOWERS} entries`
            };
          }
        }

        this.logger.debug('[FollowersSyncV2Api] getPartialCollection', {
          actorIdentifier,
          baseUri,
          hostnameCandidateCount: hostnameCandidates.length,
          partialCount: followers.length,
          responseBytes
        });

        ctx.meta.$statusCode = 200;
        return { followers };
      }
    }
  },

  methods: {
    parseBearerToken(header) {
      if (typeof header !== 'string') return '';
      const match = header.match(/^Bearer\s+(.+)$/i);
      return match ? match[1].trim() : '';
    },

    safeTokenEquals(expected, actual) {
      if (!expected || !actual) return false;
      const expectedBytes = Buffer.from(expected);
      const actualBytes = Buffer.from(actual);
      if (expectedBytes.length !== actualBytes.length) return false;
      return crypto.timingSafeEqual(expectedBytes, actualBytes);
    },

    normalizeServerBaseUri(value) {
      if (typeof value !== 'string' || !value || value.length > MAX_HTTP_URI_LENGTH) return null;
      try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
        if (parsed.search || parsed.hash || parsed.pathname !== '/') return null;
        return `${parsed.origin}/`;
      } catch {
        return null;
      }
    },

    serverBaseUriForActor(actorUri) {
      if (typeof actorUri !== 'string' || !actorUri || actorUri.length > MAX_HTTP_URI_LENGTH) return null;
      try {
        const parsed = new URL(actorUri);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
        return `${parsed.origin}/`;
      } catch {
        return null;
      }
    },

    async findActorByIdentifier(ctx, identifier) {
      try {
        const account = await ctx.call('auth.account.findByUsername', { username: identifier });
        if (!account?.webId) return null;
        const actor = await ctx.call('activitypub.actor.get', { actorUri: account.webId });
        return actor || null;
      } catch {
        return null;
      }
    }
  }
};
