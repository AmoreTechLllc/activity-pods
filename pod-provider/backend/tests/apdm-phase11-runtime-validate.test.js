'use strict';

const {
  EXPECTED_CONCURRENCY,
  EXPECTED_MAX_CONTEXTS,
  EXPECTED_MAX_KEYS,
  exactBooleanString,
  positiveIntegerString,
  validatePhase11Runtime
} = require('../scripts/apdm-phase11-runtime-validate');

function runtime(overrides = {}) {
  return {
    SEMAPPS_APDM_PHASE8_INSTRUMENTATION_ENABLED: 'true',
    SEMAPPS_APDM_PHASE8_RECIPIENT_COUNT: '1000',
    SEMAPPS_APDM_PHASE8_CASE_LABEL: 'real-local-1000',
    SEMAPPS_APDM_PHASE11_QUERY_ATTRIBUTION_ENABLED: 'true',
    SEMAPPS_APDM_PHASE11_QUERY_ATTRIBUTION_MAX_KEYS: String(EXPECTED_MAX_KEYS),
    SEMAPPS_APDM_PHASE11_QUERY_ATTRIBUTION_MAX_CONTEXTS: String(EXPECTED_MAX_CONTEXTS),
    APDM_LOCAL_DELIVERY_DATASET_EXIST_MEMO_ENABLED: 'true',
    APDM_LOCAL_DELIVERY_CONCURRENCY: String(EXPECTED_CONCURRENCY),
    APDM_P10_MEASUREMENT_ARM: 'on',
    ...overrides
  };
}

describe('APDM Phase 11 live runtime validator', () => {
  test('accepts the exact attributed-arm benchmark runtime', () => {
    expect(validatePhase11Runtime(runtime(), 'true', '1000')).toEqual({
      checked: true,
      attributionEnabled: true,
      recipientCount: 1000,
      maxAttributionKeys: 4096,
      maxLineageContexts: 65536,
      localDeliveryConcurrency: 4,
      phase10MemoEnabled: true,
      phase10Arm: 'on'
    });
  });

  test('accepts the exact control-arm benchmark runtime', () => {
    const result = validatePhase11Runtime(
      runtime({ SEMAPPS_APDM_PHASE11_QUERY_ATTRIBUTION_ENABLED: 'false' }),
      'false',
      '1000'
    );
    expect(result.attributionEnabled).toBe(false);
  });

  test.each([
    ['SEMAPPS_APDM_PHASE8_INSTRUMENTATION_ENABLED', 'false', /Phase 8 instrumentation/u],
    ['SEMAPPS_APDM_PHASE8_RECIPIENT_COUNT', '999', /recipient count must be 1000/u],
    ['SEMAPPS_APDM_PHASE8_CASE_LABEL', 'real-local-999', /case label/u],
    ['SEMAPPS_APDM_PHASE11_QUERY_ATTRIBUTION_ENABLED', 'false', /runtime attribution flag must be true/u],
    ['SEMAPPS_APDM_PHASE11_QUERY_ATTRIBUTION_MAX_KEYS', '4095', /max attribution keys/u],
    ['SEMAPPS_APDM_PHASE11_QUERY_ATTRIBUTION_MAX_CONTEXTS', '65535', /max lineage contexts/u],
    ['APDM_LOCAL_DELIVERY_DATASET_EXIST_MEMO_ENABLED', 'false', /Phase 10 memo/u],
    ['APDM_LOCAL_DELIVERY_CONCURRENCY', '3', /local delivery concurrency/u],
    ['APDM_P10_MEASUREMENT_ARM', 'off', /measurement arm/u]
  ])('rejects runtime drift in %s', (key, value, expected) => {
    expect(() => validatePhase11Runtime(runtime({ [key]: value }), 'true', '1000')).toThrow(expected);
  });

  test('rejects non-exact boolean and integer encodings', () => {
    expect(() => exactBooleanString('TRUE', 'flag')).toThrow(/exactly true or false/u);
    expect(() => positiveIntegerString('4.0', 'count')).toThrow(/positive integer string/u);
    expect(() => positiveIntegerString('0', 'count')).toThrow(/positive integer string/u);
  });
});
