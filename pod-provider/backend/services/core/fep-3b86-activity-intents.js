/**
 * FEP-3B86 — Activity Intents
 * https://w3id.org/fep/3b86
 *
 * Publishes Activity Intent link templates in the WebFinger response and
 * exposes the matching home-server intent endpoints. All endpoints are
 * GET-only and never mutate state (CSRF safe per §6.1); they redirect the
 * user to the frontend authorization workflow which performs the activity
 * after confirmation.
 *
 * The set of intents published here is intentionally limited to the activity
 * types that ActivityPods actually exposes (Follow, Like, Announce, Create,
 * Flag, Block, Object). Adding more is a matter of registering the link in
 * `getLinks` and adding a matching alias in `started()`.
 */

const CONFIG = require('../../config/config');

const REL_NS = 'https://w3id.org/fep/3b86/';

/**
 * The intents we publish. Order matters only for stable test snapshots.
 *
 * `frontendPath` is the path on the frontend authorization UI that handles the
 * intent. The frontend is responsible for: (a) ensuring the user is logged in
 * (sign-in if not), (b) confirming the action, and (c) honouring on-success /
 * on-cancel through an interstitial redirect page (§3.4 / §6.2).
 */
const INTENT_DEFINITIONS = [
  { type: 'Follow', frontendPath: '/i/follow', params: ['object'] },
  { type: 'Like', frontendPath: '/i/like', params: ['object'] },
  { type: 'Announce', frontendPath: '/i/announce', params: ['object'] },
  { type: 'Create', frontendPath: '/i/create', params: ['type', 'name', 'summary', 'content', 'inReplyTo', 'attachment', 'tag'] },
  { type: 'Flag', frontendPath: '/i/flag', params: ['object'] },
  { type: 'Block', frontendPath: '/i/block', params: ['object'] },
  { type: 'Object', frontendPath: '/i/object', params: ['object'], hasWorkflow: false }
];

const WORKFLOW_PARAMS = ['on-success', 'on-cancel'];
const CLOSE_TOKEN = '(close)';
// Per-parameter byte cap. URLs above ~8KB are routinely rejected by reverse
// proxies; capping individual values at 4KB keeps the resulting redirect URL
// well within that bound and prevents memory amplification on the GET path.
const MAX_PARAM_LENGTH = 4096;
const SAFE_PARAM_KEYS = new Set([
  ...INTENT_DEFINITIONS.flatMap(d => d.params),
  ...WORKFLOW_PARAMS,
  // Spec-listed Create extras we don't actively expose but accept defensively.
  'startTime',
  'endTime',
  'describes'
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
      // E.g. 'GET /intents/follow': 'fep-3b86-activity-intents.handleFollow'
      aliases[`GET /intents/${intent.type.toLowerCase()}`] =
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
    /**
     * Returns the array of FEP-3B86 link descriptors to be merged into a
     * WebFinger response. Same set for every actor (per §3.6 the values are
     * uniform across actors, so they may also be published for the
     * @application actor — that is left to the WebFinger service).
     */
    getLinks: {
      params: {
        baseUrl: { type: 'string', optional: true }
      },
      handler(ctx) {
        return this.buildLinks(ctx.params.baseUrl || this.settings.baseUrl);
      }
    },

    handleFollow: {
      handler(ctx) {
        return this.runIntent(ctx, 'Follow');
      }
    },
    handleLike: {
      handler(ctx) {
        return this.runIntent(ctx, 'Like');
      }
    },
    handleAnnounce: {
      handler(ctx) {
        return this.runIntent(ctx, 'Announce');
      }
    },
    handleCreate: {
      handler(ctx) {
        return this.runIntent(ctx, 'Create');
      }
    },
    handleFlag: {
      handler(ctx) {
        return this.runIntent(ctx, 'Flag');
      }
    },
    handleBlock: {
      handler(ctx) {
        return this.runIntent(ctx, 'Block');
      }
    },
    handleObject: {
      handler(ctx) {
        return this.runIntent(ctx, 'Object');
      }
    }
  },

  methods: {
    /**
     * Builds the FEP-3B86 link templates rooted at `baseUrl`. We intentionally
     * use literal `{name}` placeholders (RFC 6570 Level 1) and not query-string
     * encoded ones so callers know they are the parameters described in §3.3.
     */
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

    /**
     * Validates query parameters against the intent definition, then redirects
     * (302) to the frontend handler. Unrecognized values are dropped per §3.2
     * ("Remote servers MUST replace unrecognized values with an empty string"
     * — we apply the same defensive filter on ingest so we never propagate
     * attacker-controlled keys).
     *
     * Hard errors (e.g. malformed `object` URL) result in a 400; this is a
     * GET endpoint so we never mutate state regardless.
     */
    runIntent(ctx, type) {
      const intent = this.settings.intents.find(d => d.type === type);
      if (!intent) {
        throw new Error(`fep-3b86-activity-intents: unknown intent type ${type}`);
      }

      const raw = ctx.params || {};
      const sanitized = this.sanitizeParams(raw, intent);
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
      // Body is informational; clients follow the Location header.
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
        if (value.length > MAX_PARAM_LENGTH) continue;
        if (!SAFE_PARAM_KEYS.has(key)) continue;
        if (!allowed.has(key)) continue;
        out[key] = value;
      }
      return out;
    },

    validateParams(params, intent) {
      // `object`/`target`/`origin`/`location`/`inReplyTo`/`attachment`/`tag`
      // — when present these MUST be absolute http(s) URLs (per §3.3 they are
      // ID references to JSON-LD resources).
      const urlParams = ['object', 'target', 'origin', 'location', 'inReplyTo', 'attachment', 'tag'];
      for (const key of urlParams) {
        if (params[key] !== undefined && !isAbsoluteHttpUrl(params[key])) {
          return { ok: false, error: `Invalid URL for parameter "${key}"` };
        }
      }

      // The Create intent is the only one whose `object` is optional — every
      // other intent that declares `object` requires it.
      const requiresObject =
        intent.params.includes('object') && intent.type !== 'Create';
      if (requiresObject && !params.object) {
        return { ok: false, error: 'Missing required parameter "object"' };
      }

      // Workflow params: each must be either the literal "(close)" token or an
      // absolute http(s) URL (§3.4). Anything else is rejected to avoid the
      // open-redirect class (§6.2).
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
    // Reject userinfo (e.g. https://user:pass@evil.example) — these are a
    // well-known phishing vector when reflected to a UI that displays the
    // hostname (FEP-3B86 §6.2 calls out URL handling on workflow params).
    if (parsed.username !== '' || parsed.password !== '') return false;
    return true;
  } catch (e) {
    return false;
  }
}

module.exports.INTENT_DEFINITIONS = INTENT_DEFINITIONS;
module.exports.REL_NS = REL_NS;
module.exports.MAX_PARAM_LENGTH = MAX_PARAM_LENGTH;
