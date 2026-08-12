const CLOSE_TOKEN = '(close)';
const MAX_PARAM_LENGTH = 4096;
const PUBLIC_URI = 'https://www.w3.org/ns/activitystreams#Public';
const INTENT_TYPES = new Set(['Follow', 'Announce', 'Create', 'Object']);
const URL_PARAMS = new Set(['object', 'attachment', 'tag', 'describes']);
const CREATE_PARAMS = new Set([
  'type',
  'name',
  'summary',
  'content',
  'attachment',
  'tag',
  'startTime',
  'endTime',
  'describes'
]);

export function isAbsoluteHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PARAM_LENGTH) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

export function parseIntentSearch(type, searchParams) {
  if (!INTENT_TYPES.has(type)) return { ok: false, error: 'Unsupported Activity Intent' };

  const params = {};
  for (const [key, value] of searchParams.entries()) {
    if (value.length > MAX_PARAM_LENGTH) return { ok: false, error: `Parameter "${key}" is too long` };
    if (value.length === 0) continue;
    if (key === 'on-success' || key === 'on-cancel') {
      if (value !== CLOSE_TOKEN && !isAbsoluteHttpUrl(value)) {
        return { ok: false, error: `Invalid ${key} workflow target` };
      }
      params[key] = value;
      continue;
    }

    const allowed = type === 'Create' ? CREATE_PARAMS.has(key) : key === 'object';
    if (!allowed) continue;
    if (URL_PARAMS.has(key) && !isAbsoluteHttpUrl(value)) {
      return { ok: false, error: `Invalid URL for parameter "${key}"` };
    }
    params[key] = value;
  }

  if (type !== 'Create' && !params.object) {
    return { ok: false, error: 'Missing required parameter "object"' };
  }
  return { ok: true, params };
}

function followersCollection(actor) {
  return `${actor.replace(/\/+$/, '')}/followers`;
}

export function buildIntentActivity(type, params, actor) {
  if (!actor || typeof actor !== 'string') throw new Error('Authenticated outbox owner is unavailable');
  if (type === 'Object') return null;

  if (type === 'Follow') {
    return {
      type: 'Follow',
      actor,
      object: params.object,
      to: params.object
    };
  }

  const publicRecipients = {
    to: PUBLIC_URI,
    cc: [followersCollection(actor)]
  };

  if (type === 'Create') {
    const object = { type: params.type || 'Note' };
    for (const key of CREATE_PARAMS) {
      if (key === 'type') continue;
      if (params[key] !== undefined && params[key] !== '') object[key] = params[key];
    }
    return {
      type: 'Create',
      actor,
      object,
      ...publicRecipients
    };
  }

  if (type === 'Announce') {
    return {
      type: 'Announce',
      actor,
      object: params.object,
      ...publicRecipients
    };
  }

  throw new Error(`Unsupported executable Activity Intent: ${type}`);
}

export function getWorkflowAction(params, outcome) {
  const key = outcome === 'success' ? 'on-success' : 'on-cancel';
  const target = params?.[key];
  if (!target) return { kind: 'none' };
  if (target === CLOSE_TOKEN) return { kind: 'close' };
  if (isAbsoluteHttpUrl(target)) return { kind: 'confirm-navigation', target };
  return { kind: 'none' };
}

export { CLOSE_TOKEN, MAX_PARAM_LENGTH, PUBLIC_URI };