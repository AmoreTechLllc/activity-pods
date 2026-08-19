'use strict';

const {
  coefficientOfVariation,
  metricVariance,
  sampleStandardDeviation,
  summarizeAdspTier1
} = require('../scripts/adsp-p0-tier1-summarize');

function record(recipientCount, index, overrides = {}) {
  return {
    phase: 'APDM-P8-A',
    recipientCount,
    elapsedMs: 100 + index,
    cpuUserMs: 20 + index,
    cpuSystemMs: 5,
    heapUsedDelta: 100 + index,
    rssEnd: 1000 + index,
    actionCount: recipientCount * 2 + index,
    fuseki: { requestCount: recipientCount * 3 + index },
    errors: [],
    ...overrides
  };
}

describe('ADSP P0 Tier-1 baseline summary', () => {
  test('computes sample standard deviation and coefficient of variation', () => {
    expect(sampleStandardDeviation([1, 2, 3])).toBeCloseTo(1);
    expect(coefficientOfVariation([1, 2, 3])).toBeCloseTo(0.5);
    expect(sampleStandardDeviation([1])).toBeUndefined();
    expect(coefficientOfVariation([0, 0])).toBeUndefined();
  });

  test('reports robust percentile and range fields without discarding variance', () => {
    expect(metricVariance([10, 20, 30, 40, 50])).toMatchObject({
      samples: 5,
      mean: 30,
      min: 10,
      p50: 30,
      p95: 50,
      p99: 50,
      max: 50
    });
  });

  test('requires the canonical recipient matrix and enough successful samples per case', () => {
    const records = [];
    for (const count of [1, 10, 100, 200, 1000]) {
      for (let index = 0; index < 5; index += 1) records.push(record(count, index));
    }

    const summary = summarizeAdspTier1(records, {
      minSamples: 5,
      provenance: { commitSha: 'abc123' }
    });

    expect(summary.complete).toBe(true);
    expect(summary.totalFailedSamples).toBe(0);
    expect(summary.incompleteCases).toEqual([]);
    expect(summary.provenance).toEqual({ commitSha: 'abc123' });
    expect(summary.scope).toMatchObject({ activityPodsTier1: true, federationSidecar: false });
    expect(summary.cases[1000].successfulSamples).toBe(5);
    expect(summary.cases[1000].normalizedPerRecipient.actionCount.mean).toBeCloseTo(2.002);
    expect(summary.cases[1000].variance.elapsedMs.coefficientOfVariation).toBeGreaterThan(0);
  });

  test('fails the evidence gate when a canonical case is undersampled or has a failed trace', () => {
    const records = [];
    for (const count of [1, 10, 100, 200, 1000]) {
      const samples = count === 200 ? 4 : 5;
      for (let index = 0; index < samples; index += 1) records.push(record(count, index));
    }
    records.push(record(1000, 99, { errors: [{ source: 'test', message: 'failure' }] }));

    const summary = summarizeAdspTier1(records, { minSamples: 5 });

    expect(summary.complete).toBe(false);
    expect(summary.totalFailedSamples).toBe(1);
    expect(summary.incompleteCases).toEqual([
      { recipientCount: 200, successfulSamples: 4, requiredSuccessfulSamples: 5 }
    ]);
  });

  test('ignores unrelated instrumentation phases rather than counting them as evidence', () => {
    const records = [record(1, 0), { ...record(1, 1), phase: 'SOME-OTHER-PHASE' }];
    const summary = summarizeAdspTier1(records, { minSamples: 2 });

    expect(summary.totalRecords).toBe(1);
    expect(summary.complete).toBe(false);
    expect(summary.cases[1].samples).toBe(1);
  });

  test('rejects a sample floor too small to characterize variance', () => {
    expect(() => summarizeAdspTier1([], { minSamples: 1 })).toThrow(/minSamples must be an integer >= 2/u);
  });
});
