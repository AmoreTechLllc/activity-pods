'use strict';

const { isSuccessfulRecord, summarize } = require('../scripts/apdm-phase8-summarize');

function validRecord(overrides = {}) {
  return {
    phase: 'APDM-P8-A',
    recipientCount: 1,
    elapsedMs: 10,
    cpuUserMs: 3,
    cpuSystemMs: 1,
    heapUsedDelta: 0,
    actionCount: 4,
    actionCounts: {},
    categoryCounts: {},
    fuseki: { requestCount: 2, pathCounts: {}, methodCounts: {}, statusCounts: {}, requestKeyCounts: {} },
    errors: [],
    ...overrides
  };
}

describe('APDM Phase 8 summary hardening', () => {
  test('missing errors array is corruption, not success', () => {
    const record = validRecord();
    delete record.errors;
    expect(isSuccessfulRecord(record)).toBe(false);
  });

  test('non-finite or missing core metrics cannot satisfy a sample', () => {
    expect(isSuccessfulRecord(validRecord({ elapsedMs: NaN }))).toBe(false);
    expect(isSuccessfulRecord(validRecord({ cpuUserMs: undefined }))).toBe(false);
    expect(isSuccessfulRecord(validRecord({ actionCount: -1 }))).toBe(false);
    expect(isSuccessfulRecord(validRecord({ fuseki: { requestCount: -1 } }))).toBe(false);
  });

  test('three malformed records cannot make an N complete', () => {
    const records = Array.from({ length: 3 }, () => validRecord({ errors: undefined }));
    const summary = summarize(records, [1]);
    expect(summary.complete).toBe(false);
    expect(summary.missingRecipientCounts).toEqual([1]);
    expect(summary.cases[1].successfulSamples).toBe(0);
  });
});
