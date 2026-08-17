'use strict';

const {
  DATASET_EXIST_ACTION,
  MIN_DATASET_REGISTRY_REDUCTION,
  MIN_MEASURED_SAMPLES,
  compare,
  meanActionCount,
  meanDatasetRegistryRequests,
  renderMarkdown
} = require('../scripts/apdm-phase10-compare');

const COUNTS = [1, 10, 100, 200, 1000];

function caseSummary({
  samples = 3,
  datasetExistPerSample,
  datasetRegistryPerSample,
  fusekiPerSample,
  elapsed = 1000,
  failedSamples = 0
}) {
  const successfulSamples = samples - failedSamples;
  return {
    samples,
    successfulSamples,
    failedSamples,
    elapsedMs: { mean: elapsed },
    cpuMs: { mean: elapsed / 2 },
    heapUsedDeltaBytes: { mean: 1024 },
    actionCount: { mean: 500 },
    fusekiRequestCount: { mean: fusekiPerSample },
    actionCounts: {
      [DATASET_EXIST_ACTION]: datasetExistPerSample * successfulSamples
    },
    fusekiRequestKeyCounts: {
      'GET /$/datasets/alice': datasetRegistryPerSample * successfulSamples,
      'DELETE /$/datasets/alice': 2 * successfulSamples,
      'POST /alice/query': 10 * successfulSamples
    }
  };
}

function summary({
  registryReduction = 0,
  actionReduction = 0,
  fusekiReduction = 0,
  failedAt,
  samples = 3
} = {}) {
  const cases = {};
  for (const count of COUNTS) {
    const controlDatasetExists = 20 + count * 16;
    const controlFuseki = 100 + count * 29;
    cases[count] = caseSummary({
      samples,
      datasetExistPerSample: controlDatasetExists * (1 - actionReduction),
      datasetRegistryPerSample: controlDatasetExists * (1 - registryReduction),
      fusekiPerSample: controlFuseki * (1 - fusekiReduction),
      elapsed: 1000 + count,
      failedSamples: failedAt === count ? 1 : 0
    });
  }
  return { complete: true, cases };
}

describe('APDM Phase 10 evidence comparator', () => {
  test('normalizes aggregated action and exact Fuseki registry GET counts to per-sample means', () => {
    const current = caseSummary({
      datasetExistPerSample: 42,
      datasetRegistryPerSample: 40,
      fusekiPerSample: 90
    });
    expect(meanActionCount(current, DATASET_EXIST_ACTION)).toBe(42);
    expect(meanDatasetRegistryRequests(current)).toBe(40);
  });

  test('does not count a DELETE to the dataset registry path as an existence probe', () => {
    const current = caseSummary({
      datasetExistPerSample: 5,
      datasetRegistryPerSample: 3,
      fusekiPerSample: 10
    });
    expect(meanDatasetRegistryRequests(current)).toBe(3);
  });

  test('gates on real dataset-registry GETs even when outer middleware still counts attempted actions', () => {
    const result = compare(
      summary(),
      summary({ registryReduction: 0.8, actionReduction: 0, fusekiReduction: 0.35 })
    );

    expect(result.gate.passed).toBe(true);
    expect(result.gate.scope).toBe('mechanism-and-delivery-correctness');
    expect(result.gate.requiresManualResourceReview).toBe(true);
    expect(result.gate.failures).toEqual([]);
    expect(result.cases[1000].deltas.datasetRegistryReduction).toBeCloseTo(0.8);
    expect(result.cases[1000].deltas.datasetExistActionCountPercent).toBeCloseTo(0);
    expect(result.cases[1000].deltas.fusekiRequestCountPercent).toBeCloseTo(-35);
  });

  test('fails closed when either arm has fewer than the canonical minimum samples', () => {
    const result = compare(
      summary({ samples: MIN_MEASURED_SAMPLES - 1 }),
      summary({ registryReduction: 0.8, fusekiReduction: 0.3, samples: MIN_MEASURED_SAMPLES - 1 })
    );

    expect(result.gate.passed).toBe(false);
    expect(result.gate.failures).toEqual(
      expect.arrayContaining([expect.stringContaining(`requires at least ${MIN_MEASURED_SAMPLES} measured samples`)])
    );
  });

  test('fails closed when control and enabled sample counts differ', () => {
    const result = compare(
      summary({ samples: 3 }),
      summary({ registryReduction: 0.8, fusekiReduction: 0.3, samples: 4 })
    );

    expect(result.gate.passed).toBe(false);
    expect(result.gate.failures).toEqual(expect.arrayContaining([expect.stringContaining('unmatched sample counts')]));
  });

  test('fails closed when the intended large-case metadata round-trip reduction is not material', () => {
    const result = compare(
      summary(),
      summary({ registryReduction: MIN_DATASET_REGISTRY_REDUCTION - 0.01, fusekiReduction: 0.2 })
    );

    expect(result.gate.passed).toBe(false);
    expect(result.gate.failures).toEqual(
      expect.arrayContaining([expect.stringContaining('reduced Fuseki dataset-registry GETs by only')])
    );
  });

  test('fails when total Fuseki requests do not fall in a large case', () => {
    const result = compare(summary(), summary({ registryReduction: 0.8, fusekiReduction: 0 }));

    expect(result.gate.passed).toBe(false);
    expect(result.gate.failures).toEqual(expect.arrayContaining([expect.stringContaining('total Fuseki')]));
  });

  test('fails when either side contains a failed delivery sample', () => {
    const result = compare(
      summary(),
      summary({ registryReduction: 0.8, fusekiReduction: 0.3, failedAt: 200 })
    );

    expect(result.gate.passed).toBe(false);
    expect(result.gate.failures).toEqual(expect.arrayContaining([expect.stringContaining('requires all measured samples to succeed')]));
  });

  test('renders a concise markdown evidence table without implying production approval', () => {
    const result = compare(summary(), summary({ registryReduction: 0.8, fusekiReduction: 0.3 }));
    const markdown = renderMarkdown(result);

    expect(markdown).toContain('APDM Phase 10 dataset-existence memo comparison');
    expect(markdown).toContain('Mechanism/delivery gate: **PASS**');
    expect(markdown).toContain('not production promotion approval');
    expect(markdown).toContain('samples off/on');
    expect(markdown).toContain('registry GET off');
    expect(markdown).toContain('| 1000 |');
  });
});
