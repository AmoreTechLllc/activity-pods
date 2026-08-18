'use strict';

const {
  assertCaseIdentityUniqueness,
  buildSummary,
  compareScale,
  validateWindow
} = require('../scripts/adsp-p2-horizontal-summarize');

function windowFor({ replicas, recipients, throughput, p95 = 100, p99 = 120, executorCounts, seed = 'w' }) {
  const counts = executorCounts || { r1: 8 };
  const executors = Object.entries(counts).flatMap(([name, count]) => Array.from({ length: Number(count) }, () => name));
  return {
    phase: 'ADSP-P2-A',
    replicaCount: replicas,
    recipientCount: recipients,
    requestCount: 8,
    successfulOutcomes: 8,
    failedOutcomes: 0,
    duplicateRequestIds: 0,
    duplicateActivityIds: 0,
    throughputPerSecond: throughput,
    completedMs: { p95, p99 },
    executorCounts: counts,
    results: Array.from({ length: 8 }, (_, index) => ({
      requestId: `${seed}-req-${index + 1}`,
      activityId: `${seed}-activity-${index + 1}`,
      executor: executors[index]
    }))
  };
}

function caseEntry(replicas, recipients, throughput, p95, executorCounts) {
  return {
    replicaCount: replicas,
    recipientCount: recipients,
    files: Array.from({ length: 5 }, (_, index) => `${replicas}r-${recipients}n-s${index + 1}.json`),
    windows: Array.from({ length: 5 }, (_, index) =>
      windowFor({ replicas, recipients, throughput, p95, executorCounts, seed: `${replicas}r-${recipients}n-s${index + 1}` })
    )
  };
}

describe('ADSP P2 horizontal scale summarizer', () => {
  test('rejects correctness drift and executor-accounting gaps', () => {
    expect(() =>
      validateWindow(
        { ...windowFor({ replicas: 2, recipients: 10, throughput: 1, executorCounts: { r1: 4, r2: 3 } }) },
        { label: 'bad', replicaCount: 2, recipientCount: 10 }
      )
    ).toThrow(/Executor accounting mismatch/u);

    expect(() =>
      validateWindow(
        { ...windowFor({ replicas: 1, recipients: 10, throughput: 1 }), duplicateActivityIds: 1 },
        { label: 'bad', replicaCount: 1, recipientCount: 10 }
      )
    ).toThrow(/Duplicate authoritative outcome/u);
  });

  test('rejects missing per-request results and cross-window identity reuse', () => {
    const first = windowFor({ replicas: 1, recipients: 10, throughput: 1, seed: 'first' });
    expect(() =>
      validateWindow({ ...first, results: first.results.slice(0, 7) }, { label: 'short', replicaCount: 1, recipientCount: 10 })
    ).toThrow(/Per-request result accounting mismatch/u);

    const second = windowFor({ replicas: 1, recipients: 10, throughput: 1, seed: 'second' });
    second.results[0].activityId = first.results[0].activityId;
    expect(() =>
      assertCaseIdentityUniqueness({ replicaCount: 1, recipientCount: 10, windows: [first, second] })
    ).toThrow(/Activity ID reused across measured windows/u);
  });

  test('throughput closes scale gate at 1.50x', () => {
    const smaller = {
      replicaCount: 1,
      throughputPerSecond: { p50: 10 },
      completedP95Ms: { p50: 100 }
    };
    const larger = {
      replicaCount: 2,
      throughputPerSecond: { p50: 15 },
      completedP95Ms: { p50: 95 }
    };
    const result = compareScale(smaller, larger);
    expect(result.throughputRatio).toBe(1.5);
    expect(result.throughputGatePassed).toBe(true);
    expect(result.scaleGateClosed).toBe(true);
  });

  test('latency-only improvement is reported but cannot close gate without saturation proof', () => {
    const result = compareScale(
      { replicaCount: 1, throughputPerSecond: { p50: 10 }, completedP95Ms: { p50: 100 } },
      { replicaCount: 2, throughputPerSecond: { p50: 11 }, completedP95Ms: { p50: 75 } }
    );
    expect(result.throughputGatePassed).toBe(false);
    expect(result.latencyThresholdObserved).toBe(true);
    expect(result.latencyGateRequiresIndependentSaturationProof).toBe(true);
    expect(result.scaleGateClosed).toBe(false);
  });

  test('requires five valid windows for every 1/2/4 case', () => {
    const cases = {
      '1r-10n': caseEntry(1, 10, 10, 100, { r1: 8 }),
      '2r-10n': caseEntry(2, 10, 16, 80, { r1: 4, r2: 4 }),
      '4r-10n': caseEntry(4, 10, 25, 60, { r1: 2, r2: 2, r3: 2, r4: 2 })
    };
    const summary = buildSummary(cases, [10]);
    expect(summary.complete).toBe(true);
    expect(summary.cases['4r-10n'].uniqueRequestIds).toBe(40);
    expect(summary.cases['4r-10n'].uniqueActivityIds).toBe(40);
    expect(summary.scale['10n'].oneToTwo.throughputGatePassed).toBe(true);
    expect(summary.scale['10n'].twoToFour.throughputGatePassed).toBe(true);

    cases['4r-10n'].windows = cases['4r-10n'].windows.slice(0, 4);
    const incomplete = buildSummary(cases, [10]);
    expect(incomplete.complete).toBe(false);
    expect(incomplete.incompleteCases).toEqual([{ key: '4r-10n', successfulSamples: 4, required: 5 }]);
  });
});
