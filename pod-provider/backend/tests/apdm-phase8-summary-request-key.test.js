'use strict';

const { summarize } = require('../scripts/apdm-phase8-summarize');

describe('APDM Phase 8 request-key summary evidence', () => {
  test('aggregates only successful trace request-key counts', () => {
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
          'GET /$/datasets/alice': 2,
          'DELETE /$/datasets/alice': 1
        }
      },
      errors: []
    };
    const failed = {
      ...successful,
      fuseki: {
        requestCount: 100,
        requestKeyCounts: { 'GET /$/datasets/broken': 100 }
      },
      errors: [{ source: 'root-action', message: 'failed' }]
    };

    const result = summarize([successful, failed], [1]);

    expect(result.complete).toBe(true);
    expect(result.cases[1].fusekiRequestKeyCounts).toEqual({
      'GET /$/datasets/alice': 2,
      'DELETE /$/datasets/alice': 1
    });
    expect(result.cases[1].fusekiRequestKeyCounts['GET /$/datasets/broken']).toBeUndefined();
  });
});
