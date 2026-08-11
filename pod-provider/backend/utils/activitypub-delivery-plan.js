'use strict';

const crypto = require('crypto');

const DELIVERY_PLAN_SCHEMA = 'ap.delivery-plan.v1';
const DELIVERY_PLAN_FIXTURE_SHA256 = '0d38040d212f781deb71fc8a62c9f4a6bef60ef977414369e9b8a41df0d1b09a';
const DELIVERY_PLAN_JSON_SCHEMA_SHA256 = '90067ea8c3d309bccb70420920bdc976a59413ba88f477712dca9c77799dcfbe';
const VISIBILITIES = new Set(['public', 'unlisted', 'followers', 'direct']);
const PLAN_KEYS = new Set(['schema', 'intentId', 'activityId', 'actorUri', 'activity', 'localRecipients', 'remoteRecipients', 'meta']);
const LOCAL_TARGET_KEYS = new Set(['actorUri', 'dataset', 'inboxUri']);
const REMOTE_TARGET_KEYS = new Set(['actorUri', 'inboxUrl', 'sharedInboxUrl', 'targetDomain']);
const META_KEYS = new Set(['visibility', 'isPublicActivity', 'isPublicIndexable', 'searchConsent']);
const APDM_INTENT_ID_PATTERN = /^apdm-v1-[a-f0-9]{64}$/u;
const PUBLIC_ADDRESSES = new Set(['https://www.w3.org/ns/activitystreams#Public', 'as:Public', 'Public']);
const ASCII_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isCleanString(value) {
  return isNonEmptyString(value) && value === value.trim() && !ASCII_CONTROL_PATTERN.test(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.has(key));
}

function parseHttpUrl(value) {
  if (!isCleanString(value)) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseDeliveryEndpointUrl(value) {
  const parsed = parseHttpUrl(value);
  if (!parsed || parsed.hash) return null;
  return normalizeDeliveryTargetDomain(parsed.hostname) ? parsed : null;
}

function normalizeDeliveryTargetDomain(value) {
  if (!isCleanString(value)) return null;
  const normalized = value.toLowerCase().replace(/\.+$/u, '');
  return normalized.length > 0 ? normalized : null;
}

function isHttpUrl(value) {
  return Boolean(parseHttpUrl(value));
}

function normalizeId(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value.id || value['@id'] || null;
  return null;
}

function normalizeAddresses(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map(normalizeId).filter(item => typeof item === 'string');
}

function isFollowersAddress(value) {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).pathname.replace(/\/+$/u, '').endsWith('/followers');
  } catch {
    return false;
  }
}

function determineActivityVisibility(activity) {
  const to = normalizeAddresses(activity?.to);
  const cc = normalizeAddresses(activity?.cc);
  if (to.some(value => PUBLIC_ADDRESSES.has(value))) return 'public';
  if (cc.some(value => PUBLIC_ADDRESSES.has(value))) return 'unlisted';
  if (to.some(isFollowersAddress)) return 'followers';
  return 'direct';
}

function validateLocalRecipient(target) {
  return Boolean(
    target &&
      typeof target === 'object' &&
      !Array.isArray(target) &&
      hasOnlyKeys(target, LOCAL_TARGET_KEYS) &&
      isHttpUrl(target.actorUri) &&
      isCleanString(target.dataset) &&
      parseDeliveryEndpointUrl(target.inboxUri)
  );
}

function validateRemoteRecipient(target) {
  if (!(
    target &&
    typeof target === 'object' &&
    !Array.isArray(target) &&
    hasOnlyKeys(target, REMOTE_TARGET_KEYS) &&
    isHttpUrl(target.actorUri) &&
    parseDeliveryEndpointUrl(target.inboxUrl) &&
    (target.sharedInboxUrl === undefined || parseDeliveryEndpointUrl(target.sharedInboxUrl)) &&
    isCleanString(target.targetDomain)
  )) return false;

  const deliveryUrl = target.sharedInboxUrl || target.inboxUrl;
  const parsed = parseDeliveryEndpointUrl(deliveryUrl);
  const expectedDomain = parsed && normalizeDeliveryTargetDomain(parsed.hostname);
  return Boolean(expectedDomain && target.targetDomain === expectedDomain);
}

function canonicalize(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalize non-finite number');
      return JSON.stringify(value);
    case 'object': {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Cannot canonicalize non-JSON object');
      }
      return `{${Object.keys(value)
        .sort()
        .map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
        .join(',')}}`;
    }
    default:
      throw new TypeError(`Cannot canonicalize unsupported ${typeof value} value`);
  }
}

function computeDeliveryPlanIntentId({ activityId, actorUri, localRecipientUris = [], remoteRecipientUris = [] }) {
  const material = canonicalize({
    schema: DELIVERY_PLAN_SCHEMA,
    activityId,
    actorUri,
    localRecipientUris: [...new Set(localRecipientUris)].sort(),
    remoteRecipientUris: [...new Set(remoteRecipientUris)].sort()
  });
  return `apdm-v1-${crypto.createHash('sha256').update(material).digest('hex')}`;
}

function hasDuplicate(values) {
  return new Set(values).size !== values.length;
}

function validateSemanticInvariants(plan) {
  const embeddedActivityId = normalizeId(plan.activity.id || plan.activity['@id']);
  const embeddedActorUri = normalizeId(plan.activity.actor);
  if (embeddedActivityId !== plan.activityId || embeddedActorUri !== plan.actorUri) return false;

  const expectedVisibility = determineActivityVisibility(plan.activity);
  if (plan.meta.visibility !== expectedVisibility) return false;
  const expectedPublic = expectedVisibility === 'public' || expectedVisibility === 'unlisted';
  if (plan.meta.isPublicActivity !== expectedPublic) return false;
  if (plan.meta.isPublicIndexable === true && !expectedPublic) return false;

  const localUris = plan.localRecipients.map(target => target.actorUri);
  const remoteUris = plan.remoteRecipients.map(target => target.actorUri);
  if (hasDuplicate(localUris) || hasDuplicate(remoteUris)) return false;
  const localSet = new Set(localUris);
  if (remoteUris.some(uri => localSet.has(uri))) return false;

  const expectedIntentId = computeDeliveryPlanIntentId({
    activityId: plan.activityId,
    actorUri: plan.actorUri,
    localRecipientUris: localUris,
    remoteRecipientUris: remoteUris
  });
  return plan.intentId === expectedIntentId;
}

function validateDeliveryPlanV1(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return false;
  if (!hasOnlyKeys(plan, PLAN_KEYS)) return false;
  if (plan.schema !== DELIVERY_PLAN_SCHEMA) return false;
  if (!APDM_INTENT_ID_PATTERN.test(plan.intentId || '')) return false;
  if (!isHttpUrl(plan.activityId) || !isHttpUrl(plan.actorUri)) return false;
  if (!plan.activity || typeof plan.activity !== 'object' || Array.isArray(plan.activity)) return false;
  if (!Array.isArray(plan.localRecipients) || !plan.localRecipients.every(validateLocalRecipient)) return false;
  if (!Array.isArray(plan.remoteRecipients) || !plan.remoteRecipients.every(validateRemoteRecipient)) return false;
  if (!plan.meta || typeof plan.meta !== 'object' || Array.isArray(plan.meta)) return false;
  if (!hasOnlyKeys(plan.meta, META_KEYS)) return false;
  if (!VISIBILITIES.has(plan.meta.visibility)) return false;
  if (typeof plan.meta.isPublicActivity !== 'boolean') return false;
  if (plan.meta.isPublicIndexable !== undefined && typeof plan.meta.isPublicIndexable !== 'boolean') return false;
  if (
    plan.meta.searchConsent !== undefined &&
    plan.meta.searchConsent !== null &&
    (typeof plan.meta.searchConsent !== 'object' || Array.isArray(plan.meta.searchConsent))
  ) {
    return false;
  }
  return validateSemanticInvariants(plan);
}

function deliveryPlanFingerprint(value) {
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
}

module.exports = {
  APDM_INTENT_ID_PATTERN,
  DELIVERY_PLAN_SCHEMA,
  DELIVERY_PLAN_FIXTURE_SHA256,
  DELIVERY_PLAN_JSON_SCHEMA_SHA256,
  canonicalize,
  computeDeliveryPlanIntentId,
  deliveryPlanFingerprint,
  determineActivityVisibility,
  normalizeDeliveryTargetDomain,
  parseDeliveryEndpointUrl,
  validateDeliveryPlanV1
};
