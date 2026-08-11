'use strict';

const crypto = require('crypto');

const DELIVERY_PLAN_SCHEMA = 'ap.delivery-plan.v1';
const DELIVERY_PLAN_FIXTURE_SHA256 = '8a772d3c6d0555c9419ecf62f06e970ca0f82440f00db0c75b645f47fcaa27d7';
const DELIVERY_PLAN_JSON_SCHEMA_SHA256 = '555094968f8372e2e2438bf1dc6eae69d2f2541231d3a4aa7ce7efee8f5fcd9f';
const VISIBILITIES = new Set(['public', 'unlisted', 'followers', 'direct']);
const PLAN_KEYS = new Set(['schema', 'intentId', 'activityId', 'actorUri', 'activity', 'localRecipients', 'remoteRecipients', 'meta']);
const LOCAL_TARGET_KEYS = new Set(['actorUri', 'dataset', 'inboxUri']);
const REMOTE_TARGET_KEYS = new Set(['actorUri', 'inboxUrl', 'sharedInboxUrl', 'targetDomain']);
const META_KEYS = new Set(['visibility', 'isPublicActivity', 'isPublicIndexable', 'searchConsent']);
const APDM_INTENT_ID_PATTERN = /^apdm-v1-[a-f0-9]{64}$/u;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.has(key));
}

function parseHttpUrl(value) {
  if (!isNonEmptyString(value)) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isHttpUrl(value) {
  return Boolean(parseHttpUrl(value));
}

function normalizeId(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value.id || value['@id'] || null;
  return null;
}

function validateLocalRecipient(target) {
  return Boolean(
    target &&
      typeof target === 'object' &&
      !Array.isArray(target) &&
      hasOnlyKeys(target, LOCAL_TARGET_KEYS) &&
      isHttpUrl(target.actorUri) &&
      isNonEmptyString(target.dataset) &&
      isHttpUrl(target.inboxUri)
  );
}

function validateRemoteRecipient(target) {
  if (!(
    target &&
    typeof target === 'object' &&
    !Array.isArray(target) &&
    hasOnlyKeys(target, REMOTE_TARGET_KEYS) &&
    isHttpUrl(target.actorUri) &&
    isHttpUrl(target.inboxUrl) &&
    (target.sharedInboxUrl === undefined || isHttpUrl(target.sharedInboxUrl)) &&
    isNonEmptyString(target.targetDomain)
  )) return false;

  const deliveryUrl = target.sharedInboxUrl || target.inboxUrl;
  const parsed = parseHttpUrl(deliveryUrl);
  return Boolean(parsed && target.targetDomain === parsed.hostname.toLowerCase());
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
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

  const expectedPublic = plan.meta.visibility === 'public' || plan.meta.visibility === 'unlisted';
  if (plan.meta.isPublicActivity !== expectedPublic) return false;

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
  if (plan.meta.searchConsent !== undefined && plan.meta.searchConsent !== null && typeof plan.meta.searchConsent !== 'object') {
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
  validateDeliveryPlanV1
};
