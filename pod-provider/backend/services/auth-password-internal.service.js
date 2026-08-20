'use strict';

require('dotenv-flow').config();

const crypto = require('crypto');
const { MoleculerError } = require('moleculer').Errors;
const {
  MIN_SIGNING_TOKEN_BYTES,
  parseBearerToken,
  timingSafeSecretEqual
} = require('../utils/signing-security');

const MAX_PASSWORD_BYTES = 4096;
const MAX_ACCOUNT_ID_BYTES = 2048;
const MAX_FAILURES_PER_WINDOW = Number(process.env.ATPROTO_PASSWORD_VERIFY_MAX_FAILURES || 10);
const FAILURE_WINDOW_MS = Number(process.env.ATPROTO_PASSWORD_VERIFY_WINDOW_MS || 5 * 60 * 1000);
const MIN_FAILURE_LATENCY_MS = Number(process.env.ATPROTO_PASSWORD_VERIFY_MIN_FAILURE_LATENCY_MS || 120);
const MAX_TRACKED_ACCOUNTS = 10000;

function configuredPasswordVerifyToken(env = process.env) {
  const token = env.ATPROTO_PASSWORD_VERIFY_TOKEN;
  if (typeof token !== 'string') return null;
  const bytes = Buffer.byteLength(token, 'utf8');
  if (bytes < MIN_SIGNING_TOKEN_BYTES || bytes > 8 * 1024 - 7) return null;
  return /^[A-Za-z0-9\-._~+/]+=*$/.test(token) ? token : null;
}

function accountBucketKey(canonicalAccountId) {
  return crypto.createHash('sha256').update(String(canonicalAccountId), 'utf8').digest('hex');
}

module.exports = {
  name: 'auth-password-internal',

  dependencies: ['api', 'auth.account'],

  settings: {
    bearerToken: configuredPasswordVerifyToken()
  },

  created() {
    this.failureBuckets = new Map();
  },

  async started() {
    await this.broker.call('api.addRoute', {
      route: {
        name: 'auth-password-internal',
        path: '/api/internal/auth',
        authorization: false,
        authentication: false,
        bodyParsers: { json: { strict: true, limit: '16kb' } },
        onBeforeCall: (ctx, route, req) => {
          ctx.meta.$headers = req.headers;
        },
        aliases: {
          'POST /verify': 'auth-password-internal.verify'
        }
      },
      toBottom: false
    });

    if (!this.settings.bearerToken) {
      this.logger.warn(
        '[AuthPasswordInternal] ATPROTO_PASSWORD_VERIFY_TOKEN is not configured; password verification fails closed'
      );
    }
  },

  actions: {
    verify: {
      params: {
        canonicalAccountId: { type: 'string', min: 1 },
        password: { type: 'string', min: 1 }
      },
      async handler(ctx) {
        this._auth(ctx);
        const canonicalAccountId = String(ctx.params.canonicalAccountId);
        const password = String(ctx.params.password);

        if (
          Buffer.byteLength(canonicalAccountId, 'utf8') > MAX_ACCOUNT_ID_BYTES ||
          Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES
        ) {
          throw new MoleculerError('Authentication input exceeds allowed size', 400, 'INVALID_INPUT');
        }

        const bucketKey = accountBucketKey(canonicalAccountId);
        if (this._isRateLimited(bucketKey)) {
          ctx.meta.$statusCode = 429;
          return { ok: false, reason: 'rate_limited' };
        }

        const startedAt = Date.now();
        let account = null;
        try {
          account = await ctx.call('auth.account.findByWebId', { webId: canonicalAccountId });
        } catch (error) {
          throw new MoleculerError('Account authority unavailable', 503, 'AUTHORITY_UNAVAILABLE', {
            message: error?.message
          });
        }

        if (account?.webId === canonicalAccountId && account.username) {
          try {
            await ctx.call('auth.account.verify', { username: account.username, password });
            this.failureBuckets.delete(bucketKey);
            return { ok: true, scope: 'full' };
          } catch {
            // Deliberately collapse wrong-password and missing-account results.
          }
        }

        this._recordFailure(bucketKey);
        await this._padFailureLatency(startedAt);
        ctx.meta.$statusCode = 401;
        return { ok: false, reason: 'invalid_credentials' };
      }
    }
  },

  methods: {
    _auth(ctx) {
      const expected = this.settings.bearerToken;
      if (!expected) {
        throw new MoleculerError(
          'Password verification authentication is not configured',
          503,
          'AUTH_VERIFY_NOT_CONFIGURED'
        );
      }
      const authorization = ctx.meta?.$headers?.authorization || ctx.meta?.$headers?.Authorization;
      const token = parseBearerToken(authorization);
      if (!token || !timingSafeSecretEqual(token, expected)) {
        throw new MoleculerError('Invalid password-verification bearer token', 401, 'AUTH_FAILED');
      }
    },

    _isRateLimited(bucketKey, now = Date.now()) {
      const bucket = this.failureBuckets.get(bucketKey);
      if (!bucket) return false;
      if (now - bucket.windowStartedAt >= FAILURE_WINDOW_MS) {
        this.failureBuckets.delete(bucketKey);
        return false;
      }
      return bucket.failures >= MAX_FAILURES_PER_WINDOW;
    },

    _recordFailure(bucketKey, now = Date.now()) {
      let bucket = this.failureBuckets.get(bucketKey);
      if (!bucket || now - bucket.windowStartedAt >= FAILURE_WINDOW_MS) {
        bucket = { failures: 0, windowStartedAt: now, lastFailureAt: now };
      }
      bucket.failures += 1;
      bucket.lastFailureAt = now;
      this.failureBuckets.set(bucketKey, bucket);

      if (this.failureBuckets.size > MAX_TRACKED_ACCOUNTS) {
        const oldestKey = this.failureBuckets.keys().next().value;
        if (oldestKey) this.failureBuckets.delete(oldestKey);
      }
    },

    async _padFailureLatency(startedAt) {
      const elapsed = Date.now() - startedAt;
      const jitter = crypto.randomInt(0, 31);
      const remaining = MIN_FAILURE_LATENCY_MS + jitter - elapsed;
      if (remaining > 0) {
        await new Promise(resolve => setTimeout(resolve, remaining));
      }
    }
  }
};