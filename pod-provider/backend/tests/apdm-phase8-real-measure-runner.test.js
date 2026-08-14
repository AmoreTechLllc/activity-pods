'use strict';

const {
  assertUsableRecord,
  boundedMap,
  normalizeRunId,
  positiveInteger
} = require('../scripts/apdm-phase8-real-measure');

describe('APDM Phase 8 real measurement runner', () => {
  test('normalizes run IDs into bounded signup-safe prefixes', () => {
    expect(normalizeRunId('31834711667-2')).toMatch(/^p8[a-z0-9]+$/u);
    expect(normalizeRunId('31834711667-2').length).toBeLessThanOrEqual(12);
  });

  test('rejects invalid positive-integer settings', () => {
    expect(positiveInteger('3', 1, 'samples')).toBe(3);
    expect(() => positiveInteger('0', 1, 'samples')).toThrow('samples must be a positive integer');
    expect(() => positiveInteger('1.5', 1, 'samples')).toThrow('samples must be a positive integer');
  });

  test('boundedMap preserves input ordering while limiting active workers', async () => {
    let active = 0;
    let peak = 0;
    const results = await boundedMap([1, 2, 3, 4, 5], 2, async value => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active -= 1;
      return value * 10;
    });

    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  test('refuses mislabeled or partial-failure measurement records', () => {
    expect(() =>
      assertUsableRecord({ phase: 'APDM-P8-A', recipientCount: 10, errors: [] }, 10)
    ).not.toThrow();
    expect(() =>
      assertUsableRecord({ phase: 'APDM-P8-A', recipientCount: 1, errors: [] }, 10)
    ).toThrow('does not match');
    expect(() =>
      assertUsableRecord(
        {
          phase: 'APDM-P8-A',
          recipientCount: 10,
          errors: [{ source: 'detached-local-delivery-partial', failureCount: 1 }]
        },
        10
      )
    ).toThrow('contains delivery/instrumentation errors');
  });
});
