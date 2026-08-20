'use strict';

const {
  compare,
  deltaPercent,
  MAX_N1000_CPU_DRIFT_PERCENT,
  MAX_N1000_ELAPSED_DRIFT_PERCENT
} = require('../scripts/apdm-phase11-overhead-compare');

function metric(value) {
  return { mean: value, p50: value, p95: value, p99: value };
}

function caseSummary({ elapsed = 100, cpu = 80, heap = 10, actions = 1000, fuseki = 500 } = {}) {
  return {
    samples: 3,
    successfulSamples: 3,
    failedSamples: 0,
    elapsedMs: metric(elapsed),
    cpuMs: metric(cpu),
    heapUsedDeltaBytes: metric(heap),
    actionCount: metric(actions),
    fusekiRequestCount: metric(fuseki)
  };
}

function summary(overrides = {}) {
  const cases = {};
  for (const count of [1, 10, 100, 200, 1000]) cases[count] = caseSummary();
  for (const [count, value] of Object.entries(overrides)) cases[count] = caseSummary(value);
  return { complete: true, cases };
}

describe('APDM Phase 11 attribution overhead gate', () => {
  test('calculates signed deltas', () => {
    expect(deltaPercent(110, 100)).toBeCloseTo(10);
    expect(deltaPercent(90, 100)).toBeCloseTo(-10);
  });

  test('accepts modest p50 overhead with identical mechanism counts', () => {
    const result = compare(
      summary(),
      summary({ 1000: { elapsed: 105, cpu: 88, actions: 1000, fuseki: 500 } })
    );
    expect(result.gate.passed).toBe(true);
    expect(result.statistics.elapsedMs).toBe('p50');
  });

  test('rejects large apparent speedup as arm drift', () => {
    const result = compare(
      summary(),
      summary({ 1000: { elapsed: 100 * (1 - (MAX_N1000_ELAPSED_DRIFT_PERCENT + 1) / 100) } })
    );
    expect(result.gate.passed).toBe(false);
    expect(result.gate.failures.join(' ')).toMatch(/elapsed p50 drift/u);
  });

  test('rejects excessive CPU drift in either direction', () => {
    const faster = compare(
      summary(),
      summary({ 1000: { cpu: 80 * (1 - (MAX_N1000_CPU_DRIFT_PERCENT + 1) / 100) } })
    );
    const slower = compare(
      summary(),
      summary({ 1000: { cpu: 80 * (1 + (MAX_N1000_CPU_DRIFT_PERCENT + 1) / 100) } })
    );
    expect(faster.gate.passed).toBe(false);
    expect(slower.gate.passed).toBe(false);
  });

  test('rejects action or Fuseki mechanism-count changes', () => {
    const result = compare(
      summary(),
      summary({ 1000: { actions: 1001, fuseki: 501 } })
    );
    expect(result.gate.passed).toBe(false);
    expect(result.gate.failures.join(' ')).toMatch(/not observational/u);
  });
});
