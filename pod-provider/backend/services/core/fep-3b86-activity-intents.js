/**
 * FEP-3B86 — Activity Intents
 * https://w3id.org/fep/3b86
 *
 * Publishes Activity Intent link templates in the WebFinger response and
 * exposes the matching home-server intent endpoints. All endpoints are
 * GET-only and never mutate state; they redirect the authenticated user to a
 * frontend confirmation workflow. The frontend performs any Activity only
 * after explicit confirmation.
 *
 * IMPORTANT: only advertise workflows this provider can execute with correct
 * ActivityPub delivery semantics. Like/Flag/Block and threaded Create support
 * require additional object-owner/moderation resolution and are deliberately
 * not advertised until those execution paths exist.
 */

const CONFIG = require('../../config/config');

const REL_NS = 'https://w3id.org/fep/3b86/';

const INTENT_DEFINITIONS = [
  { type: 'Follow', frontendPath: '/i/follow', params: ['object'] },
  { type: 'Announce', frontendPath: '/i/announce', params: ['object'] },
  {
    type: 'Create',
    frontendPath: '/i/create',
    params: ['type', 'name', 'summary', 'content', 'attachment', 'tag', 'startTime', 'endTime', 'describes']
  },
  { type: 'Object', frontendPath: '/i/object', params: ['object'], hasWorkflow: false }
];

const WORKFLOW_PARAMS = ['on-success', 'on-cancel'];
const CLOSE_TOKEN = '(close)';
const MAX_PARAM_LENGTH = 4096;
const SAFE_PARAM_KEYS = new Set([
  ...INTENT_DEFINITIONS.flatMap(d => d.params),
  ...WORKFLOW_PARAMS
]);

module.exports = {
  name: 'fep-3b86-activity-intents',
  dependencies: ['api'],

  settings: {
    baseUrl: CONFIG.BASE_URL,
    frontendUrl: CONFIG.FRONTEND_URL || CONFIG.BASE_URL,
    intents: INTENT_DEFINITIONS
  },

  async started() {
    if (!this.settings.baseUrl) {
      throw new Error('fep-3b86-activity-intents: baseUrl is required');
    }

    const aliases = {};
    for (const intent of this.settings.intents) {
      aliases[`GET /${intent.type.toLowerCase()}`] =
        `fep-3b86-activity-intents.handle${intent.type}`;
    }

    await this.broker.call('api.addRoute', {
      route: {
        path: '/intents',
        name: 'fep-3b86-activity-intents',
        bodyParsers: false,
        aliases
      }
    });
  },

  actions: {
    getLinks: {
      params: {
        baseUrl: { type: 'string', optional: true }
      },
      handler(ctx) {
        return this.buildLinks(ctx.params.baseUrl || this.settings.baseUrl);
      }
    },

    handleFollow: { handler(ctx) { return this.runIntent(ctx, 'Follow'); } },
    handleAnnounce: { handler(ctx) { return this.runIntent(ctx, 'Announce'); } },
    handleCreate: { handler(ctx) { return this.runIntent(ctx, 'Create'); } },
    handleObject: { handler(ctx) { return this.runIntent(ctx, 'Object'); } }
  },

  methods: {
    buildLinks(baseUrl) {
      const root = stripTrailingSlash(baseUrl);
      return this.settings.intents.map(intent => {
        const path = `/intents/${intent.type.toLowerCase()}`;
        const placeholders = [...intent.params];
        if (intent.hasWorkflow !== false) placeholders.push(...WORKFLOW_PARAMS);
        const query = placeholders.map(p => `${p}={${p}}`).join('&');
        return {
          rel: `${REL_NS}${intent.type}`,
          template: `${root}${path}?${query}`
        };
      });
    },

    runIntent(ctx, type) {
      const intent = this.settings.intents.find(d => d.type === type);
      if (!intent) {
        throw new Error(`fep-3b86-activity-intents: unknown intent type ${type}`);
      }

      const sanitized = this.sanitizeParams(ctx.params || {}, intent);
      const validation = this.validateParams(sanitized, intent);
      if (!validation.ok) {
        if (ctx.meta) ctx.meta.$statusCode = 400;
        return { error: validation.error };
      }

      const target = this.buildFrontendUrl(intent, sanitized);
      if (ctx.meta) {
        ctx.meta.$statusCode = 302;
        ctx.meta.$responseHeaders = { Location: target };
      }
      return { redirect: target };
    },

    sanitizeParams(raw, intent) {
      const out = {};
      const allowed = new Set([
        ...intent.params,
        ...(intent.hasWorkflow !== false ? WORKFLOW_PARAMS : [])
      ]);
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value !== 'string') continue;
        // RFC 6570 callers replace unsupported/undefined values with empty
        // strings. Treat those optional values as absent rather than invalid.
        if (value.length === 0) continue;
        if (value.length > MAX_PARAM_LENGTH) continue;
        if (!SAFE_PARAM_KEYS.has(key)) continue;
        if (!allowed.has(key)) continue;
        out[key] = value;
      }
      return out;
    },

    validateParams(params, intent) {
      const urlParams = ['object', 'attachment', 'tag', 'describes'];
      for (const key of urlParams) {
        if (params[key] !== undefined && !isAbsoluteHttpUrl(params[key])) {
          return { ok: false, error: `Invalid URL for parameter "${key}"` };
        }
      }

      const requiresObject = intent.params.includes('object') && intent.type !== 'Create';
      if (requiresObject && !params.object) {
        return { ok: false, error: 'Missing required parameter "object"' };
      }

      for (const key of WORKFLOW_PARAMS) {
        if (params[key] === undefined) continue;
        if (params[key] === CLOSE_TOKEN) continue;
        if (!isAbsoluteHttpUrl(params[key])) {
          return { ok: false, error: `Invalid value for "${key}" (must be (close) or an absolute URL)` };
        }
      }

      return { ok: true };
    },

    buildFrontendUrl(intent, params) {
      const root = stripTrailingSlash(this.settings.frontendUrl);
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        search.append(key, value);
      }
      const qs = search.toString();
      return qs ? `${root}${intent.frontendPath}?${qs}` : `${root}${intent.frontendPath}`;
    }
  }
};

function stripTrailingSlash(url) {
  if (typeof url !== 'string') return '';
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function isAbsoluteHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username !== '' || parsed.password !== '') return false;
    return true;
  } catch (e) {
    return false;
  }
}

module.exports.INTENT_DEFINITIONS = INTENT_DEFINITIONS;
module.exports.REL_NS = REL_NS;
module.exports.MAX_PARAM_LENGTH = MAX_PARAM_LENGTH;