'use strict';

const MAX_AUTOMATIC_RECONCILIATION_LOOKBACK_MS = 72 * 60 * 60 * 1000;
const DEFAULT_AUTOMATIC_RECONCILIATION_LOOKBACK_MS = 15 * 60 * 1000;

function parseAutomaticReconciliationLookbackMs(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return DEFAULT_AUTOMATIC_RECONCILIATION_LOOKBACK_MS;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('SEMAPPS_ACTIVITYPUB_DELIVERY_RECONCILIATION_LOOKBACK_MS must be a positive finite number');
  }
  if (parsed > MAX_AUTOMATIC_RECONCILIATION_LOOKBACK_MS) {
    throw new Error(
      `SEMAPPS_ACTIVITYPUB_DELIVERY_RECONCILIATION_LOOKBACK_MS cannot exceed ${MAX_AUTOMATIC_RECONCILIATION_LOOKBACK_MS} ms (72 hours)`
    );
  }

  return Math.floor(parsed);
}

module.exports = {
  DEFAULT_AUTOMATIC_RECONCILIATION_LOOKBACK_MS,
  MAX_AUTOMATIC_RECONCILIATION_LOOKBACK_MS,
  parseAutomaticReconciliationLookbackMs
};
