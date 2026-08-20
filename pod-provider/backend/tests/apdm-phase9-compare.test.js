'use strict';

const {
  MIN_LARGE_CASE_SPEEDUP,
  MIN_MEASURED_SAMPLES,
  compare,
  renderMarkdown
} = require('../scripts/apdm-phase9-compare');

const COUNTS = [1, 10, 100, 200, 1000];

function makeCase({ elapsed, cpu = 1000, actions = 1000, fuseki = 500, samples = 3, failedSamples = 0 }) {
  return {
    samples,
    successfulSamples: samples - failedSamples,
    failedSamples,
    elapsedMs: { mean: elapsed, p50: elapsed, p95: elapsed },
    cpuMs: { mean: cpu, p50: cpu, p95: cpu },
    heapUsedDeltaBytes: { mean: 0, p50: 0, p95: 0 },
    actionCount: { mean: actions, p50: actions, p95: actions },
    fusekiRequestCount: { mean: fuseki, p50: fuseki, p95: fuseki }
  };
}

function summary({ speedups = {}, cpuMultiplier = 1, actionMultiplier = 1, fusekiMultiplier = 1, samples = 3 } = {}) {
  const cases = {};
  for (const count of COUNTS) {
    const baselineElapsed = 1000 + count * 10;
    const speedup = speedups[count] || 1;
    cases[count] = makeCase({
      elapsed: baselineElapsed / speedup,
      cpu: baselineElapsed * cpuMultiplier,
      actions: (1000 + count) * actionMultiplier,
      fuseki: (500 + count) * fusekiMultiplier,
      samples
    });
  }
  return { complete: true, cases, measuredModels: {} };
}

describe('APDM Phase 9 evidence comparator', () => {
  test('chooses the smallest concurrency with sustained large-case speedup and bounded work drift', () => {
    const result = compare({
      '1': summary(),
      '2': summary({ speedups: { 100: 1.05, 200: 1.06, 1000: 1.08 } }),
      '4': summary({ speedups: { 100: 1.18, 200: 1.2, 1000: 1.34 }, cpuMultiplier: 0.85 }),
      '8': summary({ speedups: { 100: 1.2, 200: 1.25, 1000: 1.4 }, cpuMultiplier: 0.8 })
    });

    expect(result.recommendedCandidate).toBe(4);
    expect(result.concurrencies[2].selectionGate.eligible).toBe(false);
    expect(result.concurrencies[4].selectionGate.eligible).toBe(true);
    expect(result.concurrencies[8].selectionGate.eligible).toBe(true);
  });

  test('rejects a fast candidate when nested action work drifts beyond the invariant envelope', () => {
    const result = compare({
      '1': summary(),
      '2': summary({ speedups: { 100: 1.2, 200: 1.2, 1000: 1.2 }, actionMultiplier: 1.08 }),
      '4': summary({ speedups: { 100: 1.2, 200: 1.2, 1000: 1.2 } }),
      '8': summary({ speedups: { 100: 1.2, 200: 1.2, 1000: 1.2 } })
    });

    expect(result.concurrencies[2].selectionGate.eligible).toBe(false);
    expect(result.concurrencies[2].selectionGate.failures.join('\n')).toContain('nested action drift');
    expect(result.recommendedCandidate).toBe(4);
  });

  test('requires matched complete sample sets with at least the canonical sample floor', () => {
    const summaries = {
      '1': summary(),
      '2': summary({ samples: MIN_MEASURED_SAMPLES - 1 }),
      '4': summary(),
      '8': summary()
    };
    expect(() => compare(summaries)).toThrow(`requires at least ${MIN_MEASURED_SAMPLES} measured samples`);
  });

  test('requires speedup at every large recipient count rather than one headline number', () => {
    const result = compare({
      '1': summary(),
      '2': summary({ speedups: { 100: MIN_LARGE_CASE_SPEEDUP - 0.01, 200: 1.3, 1000: 1.4 } }),
      '4': summary({ speedups: { 100: 1.2, 200: 1.2, 1000: 1.2 } }),
      '8': summary({ speedups: { 100: 1.2, 200: 1.2, 1000: 1.2 } })
    });
    expect(result.concurrencies[2].selectionGate.eligible).toBe(false);
    expect(result.concurrencies[2].selectionGate.failures.join('\n')).toContain('N=100 speedup');
  });

  test('malformed zero-denominator evidence cannot fail open into eligibility', () => {
    const baseline = summary();
    const candidate = summary({ speedups: { 100: 1.2, 200: 1.2, 1000: 1.2 } });
    baseline.cases[100].actionCount.mean = 0;
    const result = compare({
      '1': baseline,
      '2': candidate,
      '4': summary({ speedups: { 100: 1.2, 200: 1.2, 1000: 1.2 } }),
      '8': summary({ speedups: { 100: 1.2, 200: 1.2, 1000: 1.2 } })
    });
    expect(result.concurrencies[2].selectionGate.eligible).toBe(false);
    expect(result.concurrencies[2].selectionGate.failures.join('\n')).toContain('actionDeltaPctVsC1 is not finite');
  });

  test('markdown makes automated recommendation and manual promotion boundary explicit', () => {
    const result = compare({
      '1': summary(),
      '2': summary({ speedups: { 100: 1.05, 200: 1.05, 1000: 1.05 } }),
      '4': summary({ speedups: { 100: 1.2, 200: 1.2, 1000: 1.2 } }),
      '8': summary({ speedups: { 100: 1.2, 200: 1.2, 1000: 1.2 } })
    });
    const markdown = renderMarkdown(result);
    expect(markdown).toContain('Automated candidate: **4**');
    expect(markdown).toContain('not automatic production promotion');
  });
});
