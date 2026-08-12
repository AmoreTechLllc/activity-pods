'use strict';

const BLIND_RECIPIENT_SNAPSHOT_TTL_MS = 72 * 60 * 60 * 1000;
const AUTOMATIC_RECONCILIATION_SNAPSHOT_MARGIN_MS = 24 * 60 * 60 * 1000;
const MAX_AUTOMATIC_RECONCILIATION_LOOKBACK_MS =
  BLIND_RECIPIENT_SNAPSHOT_TTL_MS - AUTOMATIC_RECONCILIATION_SNAPSHOT_MARGIN_MS;
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
      `SEMAPPS_ACTIVITYPUB_DELIVERY_RECONCILIATION_LOOKBACK_MS cannot exceed ${MAX_AUTOMATIC_RECONCILIATION_LOOKBACK_MS} ms (48 hours; preserves a 24-hour margin inside the 72-hour blind-recipient snapshot lifetime)`
    );
  }

  return Math.floor(parsed);
}

module.exports = {
  AUTOMATIC_RECONCILIATION_SNAPSHOT_MARGIN_MS,
  BLIND_RECIPIENT_SNAPSHOT_TTL_MS,
  DEFAULT_AUTOMATIC_RECONCILIATION_LOOKBACK_MS,
  MAX_AUTOMATIC_RECONCILIATION_LOOKBACK_MS,
  parseAutomaticReconciliationLookbackMs
};
