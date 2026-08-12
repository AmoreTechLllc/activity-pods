'use strict';

const {
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

  test('accepts the 72-hour recovery-snapshot horizon exactly', () => {
    expect(parseAutomaticReconciliationLookbackMs(String(MAX_AUTOMATIC_RECONCILIATION_LOOKBACK_MS))).toBe(
      72 * 60 * 60 * 1000
    );
  });

  test('fails closed above the 72-hour recovery-snapshot horizon', () => {
    expect(() =>
      parseAutomaticReconciliationLookbackMs(String(MAX_AUTOMATIC_RECONCILIATION_LOOKBACK_MS + 1))
    ).toThrow(/cannot exceed .*72 hours/u);
  });

  test.each(['0', '-1', 'NaN', 'Infinity'])('rejects invalid configured lookback %s', value => {
    expect(() => parseAutomaticReconciliationLookbackMs(value)).toThrow(/positive finite number/u);
  });
});
