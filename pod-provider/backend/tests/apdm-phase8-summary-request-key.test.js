'use strict';

const { MIN_MEASURED_SAMPLES, summarize } = require('../scripts/apdm-phase8-summarize');

describe('APDM Phase 8 request-key summary evidence', () => {
  test('aggregates only valid successful trace request-key counts at the canonical sample floor', () => {
    const successful = {
      phase: 'APDM-P8-A',
      recipientCount: 1,
      elapsedMs: 10,
      cpuUserMs: 1,
      cpuSystemMs: 1,
      heapUsedDelta: 1,
      actionCount: 2,
      actionCounts: {},
      categoryCounts: {},
      fuseki: {
        requestCount: 3,
        requestKeyCounts: {
          'GET /$/datasets/:dataset': 2,
          'DELETE /$/datasets/:dataset': 1
        }
      },
      errors: []
    };
    const failed = {
      ...successful,
      fuseki: {
        requestCount: 100,
        requestKeyCounts: { 'GET /$/datasets/:dataset': 100 }
      },
      errors: [{ source: 'root-action', name: 'Error' }]
    };

    const result = summarize([
      ...Array.from({ length: MIN_MEASURED_SAMPLES }, () => ({ ...successful, fuseki: { ...successful.fuseki, requestKeyCounts: { ...successful.fuseki.requestKeyCounts } } })),
      failed
    ], [1]);

    expect(result.complete).toBe(true);
    expect(result.cases[1].successfulSamples).toBe(MIN_MEASURED_SAMPLES);
    expect(result.cases[1].failedSamples).toBe(1);
    expect(result.cases[1].fusekiRequestKeyCounts).toEqual({
      'GET /$/datasets/:dataset': 2 * MIN_MEASURED_SAMPLES,
      'DELETE /$/datasets/:dataset': MIN_MEASURED_SAMPLES
    });
  });
});
