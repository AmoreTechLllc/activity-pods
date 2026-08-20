'use strict';

require('dotenv-flow').config();

const crypto = require('crypto');
const Redis = require('ioredis');
const { MoleculerError } = require('moleculer').Errors;

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MIN_TTL_MS = 30 * 1000;
const MAX_TTL_MS = 30 * 60 * 1000;
const LOCK_PREFIX = 'activitypods:atproto:provision:v1:';

function redisUrl() {
  return (
    process.env.SEMAPPS_QUEUE_SERVICE_URL ||
    process.env.SEMAPPS_REDIS_CACHE_URL ||
    'redis://127.0.0.1:6379/1'
  );
}

function reservationKey(canonicalAccountId) {
  const digest = crypto.createHash('sha256').update(String(canonicalAccountId), 'utf8').digest('hex');
  return `${LOCK_PREFIX}${digest}`;
}

function reservationTtlMs() {
  const configured = Number(process.env.ATPROTO_PROVISION_RESERVATION_TTL_MS || DEFAULT_TTL_MS);
  if (!Number.isFinite(configured)) return DEFAULT_TTL_MS;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, Math.floor(configured)));
}

module.exports = {
  name: 'atproto-provisioning-reservation',

  created() {
    this.redis = new Redis(redisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true
    });
  },

  async started() {
    if (this.redis.status === 'wait') await this.redis.connect();
  },

  async stopped() {
    if (this.redis && this.redis.status !== 'end') {
      await this.redis.quit().catch(() => this.redis.disconnect());
    }
  },

  actions: {
    acquire: {
      params: {
        canonicalAccountId: { type: 'string', min: 1 }
      },
      async handler(ctx) {
        const canonicalAccountId = String(ctx.params.canonicalAccountId);
        const token = crypto.randomBytes(32).toString('base64url');
        const key = reservationKey(canonicalAccountId);
        const ttlMs = reservationTtlMs();
        let result;
        try {
          result = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
        } catch (error) {
          throw new MoleculerError(
            'ATProto provisioning reservation authority unavailable',
            503,
            'PROVISIONING_RESERVATION_UNAVAILABLE',
            { message: error?.message }
          );
        }
        if (result !== 'OK') {
          throw new MoleculerError(
            'ATProto identity provisioning is already in progress for this account',
            409,
            'IDENTITY_PROVISIONING_IN_PROGRESS',
            { canonicalAccountId }
          );
        }
        return { canonicalAccountId, token, expiresInMs: ttlMs };
      }
    },

    release: {
      params: {
        canonicalAccountId: { type: 'string', min: 1 },
        token: { type: 'string', min: 1 }
      },
      async handler(ctx) {
        const key = reservationKey(ctx.params.canonicalAccountId);
        const script = `
          if redis.call('GET', KEYS[1]) == ARGV[1] then
            return redis.call('DEL', KEYS[1])
          end
          return 0
        `;
        let removed;
        try {
          removed = await this.redis.eval(script, 1, key, ctx.params.token);
        } catch (error) {
          throw new MoleculerError(
            'ATProto provisioning reservation release unavailable',
            503,
            'PROVISIONING_RESERVATION_UNAVAILABLE',
            { message: error?.message }
          );
        }
        return { released: Number(removed) === 1 };
      }
    }
  },

  methods: {
    _reservationKey: reservationKey,
    _reservationTtlMs: reservationTtlMs
  }
};

module.exports.reservationKey = reservationKey;
module.exports.reservationTtlMs = reservationTtlMs;
