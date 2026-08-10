'use strict';

const crypto = require('crypto');

const DELIVERY_PLAN_SCHEMA = 'ap.delivery-plan.v1';
const DELIVERY_PLAN_FIXTURE_SHA256 = '8a772d3c6d0555c9419ecf62f06e970ca0f82440f00db0c75b645f47fcaa27d7';
const VISIBILITIES = new Set(['public', 'unlisted', 'followers', 'direct']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isHttpUrl(value) {
  if (!isNonEmptyString(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateLocalRecipient(target) {
  return Boolean(
    target &&
      typeof target === 'object' &&
      !Array.isArray(target) &&
      isHttpUrl(target.actorUri) &&
      isNonEmptyString(target.dataset) &&
      isHttpUrl(target.inboxUri)
  );
}

function validateRemoteRecipient(target) {
  return Boolean(
    target &&
      typeof target === 'object' &&
      !Array.isArray(target) &&
      isHttpUrl(target.actorUri) &&
      isHttpUrl(target.inboxUrl) &&
      (target.sharedInboxUrl === undefined || isHttpUrl(target.sharedInboxUrl)) &&
      isNonEmptyString(target.targetDomain)
  );
}

function validateDeliveryPlanV1(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return false;
  if (plan.schema !== DELIVERY_PLAN_SCHEMA) return false;
  if (!isNonEmptyString(plan.intentId)) return false;
  if (!isHttpUrl(plan.activityId) || !isHttpUrl(plan.actorUri)) return false;
  if (!plan.activity || typeof plan.activity !== 'object' || Array.isArray(plan.activity)) return false;
  if (!Array.isArray(plan.localRecipients) || !plan.localRecipients.every(validateLocalRecipient)) return false;
  if (!Array.isArray(plan.remoteRecipients) || !plan.remoteRecipients.every(validateRemoteRecipient)) return false;
  if (!plan.meta || typeof plan.meta !== 'object' || Array.isArray(plan.meta)) return false;
  if (!VISIBILITIES.has(plan.meta.visibility)) return false;
  if (typeof plan.meta.isPublicActivity !== 'boolean') return false;
  if (plan.meta.isPublicIndexable !== undefined && typeof plan.meta.isPublicIndexable !== 'boolean') return false;
  if (plan.meta.searchConsent !== undefined && plan.meta.searchConsent !== null && typeof plan.meta.searchConsent !== 'object') {
    return false;
  }
  return true;
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

function deliveryPlanFingerprint(plan) {
  return crypto.createHash('sha256').update(canonicalize(plan)).digest('hex');
}

module.exports = {
  DELIVERY_PLAN_SCHEMA,
  DELIVERY_PLAN_FIXTURE_SHA256,
  canonicalize,
  deliveryPlanFingerprint,
  validateDeliveryPlanV1
};
