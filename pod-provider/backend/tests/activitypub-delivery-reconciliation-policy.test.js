'use strict';

const {
  AUTOMATIC_RECONCILIATION_SNAPSHOT_MARGIN_MS,
  BLIND_RECIPIENT_SNAPSHOT_TTL_MS,
  DEFAULT_AUTOMATIC_RECONCILIATION_LOOKBACK_MS,
  MAX_AUTOMATIC_RECONCILIATION_LOOKBACK_MS,
  parseAutomaticReconciliationLookbackMs
} = require('../utils/activitypub-delivery-reconciliation-policy');

describe('APDM automatic reconciliation horizon policy', () => {
  test('defaults to a bounded 15-minute replay lookback', () => {
    expect(parseAutomaticReconciliationLookbackMs(undefined)).toBe(
      DEFAULT_AUTOMATIC_RECONCILIATION_LOOKBACK_MS
    );
    expect(DEFAULT_AUTOMATIC_RECONCILIATION_LOOKBACK_MS).toBe(15 * 60 * 1000);
  });

  test('keeps a 24-hour processing margin inside the 72-hour blind snapshot lifetime', () => {
    expect(BLIND_RECIPIENT_SNAPSHOT_TTL_MS).toBe(72 * 60 * 60 * 1000);
    expect(AUTOMATIC_RECONCILIATION_SNAPSHOT_MARGIN_MS).toBe(24 * 60 * 60 * 1000);
    expect(MAX_AUTOMATIC_RECONCILIATION_LOOKBACK_MS).toBe(48 * 60 * 60 * 1000);
    expect(
      BLIND_RECIPIENT_SNAPSHOT_TTL_MS - MAX_AUTOMATIC_RECONCILIATION_LOOKBACK_MS
    ).toBe(AUTOMATIC_RECONCILIATION_SNAPSHOT_MARGIN_MS);
  });

  test('accepts the 48-hour automatic replay ceiling exactly', () => {
    expect(parseAutomaticReconciliationLookbackMs(String(MAX_AUTOMATIC_RECONCILIATION_LOOKBACK_MS))).toBe(
      48 * 60 * 60 * 1000
    );
  });

  test('fails closed above the 48-hour automatic replay ceiling', () => {
    expect(() =>
      parseAutomaticReconciliationLookbackMs(String(MAX_AUTOMATIC_RECONCILIATION_LOOKBACK_MS + 1))
    ).toThrow(/cannot exceed .*48 hours.*24-hour margin.*72-hour/u);
  });

  test.each(['0', '-1', 'NaN', 'Infinity'])('rejects invalid configured lookback %s', value => {
    expect(() => parseAutomaticReconciliationLookbackMs(value)).toThrow(/positive finite number/u);
  });
});
