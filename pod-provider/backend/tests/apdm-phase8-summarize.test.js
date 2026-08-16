'use strict';

const {
  REQUIRED_RECIPIENT_COUNTS,
  aggregateNestedCounts,
  linearFit,
  parseJsonLines,
  percentile,
  summarize
} = require('../scripts/apdm-phase8-summarize');

describe('APDM Phase 8 measurement summarizer', () => {
  test('uses the required recipient sizes from the Phase 8 contract', () => {
    expect(REQUIRED_RECIPIENT_COUNTS).toEqual([1, 10, 100, 200, 1000]);
  });

  test('parses JSONL and rejects malformed records with the line number', () => {
    expect(parseJsonLines('{"phase":"APDM-P8-A"}\n\n{"recipientCount":10}\n')).toHaveLength(2);
    expect(() => parseJsonLines('{"ok":true}\nnot-json\n')).toThrow('line 2');
  });

  test('uses nearest-rank percentiles for small benchmark samples', () => {
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2);
    expect(percentile([4, 1, 3, 2], 0.95)).toBe(4);
  });

  test('fits a linear recipient-cost model', () => {
    const model = linearFit([
      { x: 1, y: 8 },
      { x: 10, y: 62 },
      { x: 100, y: 602 }
    ]);
    expect(model.slope).toBeCloseTo(6, 8);
    expect(model.intercept).toBeCloseTo(2, 8);
  });

  test('aggregates nested Fuseki evidence without changing the original trace schema', () => {
    expect(
      aggregateNestedCounts(
        [
          { fuseki: { pathCounts: { '/$/datasets/alice': 2, '/alice/query': 1 } } },
          { fuseki: { pathCounts: { '/$/datasets/alice': 3, '/bob/query': 4 } } }
        ],
        'fuseki',
        'pathCounts'
      )
    ).toEqual({ '/$/datasets/alice': 5, '/alice/query': 1, '/bob/query': 4 });
  });

  test('does not declare Phase 8 measurement complete until every required size has a successful sample', () => {
    const summary = summarize([
      {
        phase: 'APDM-P8-A',
        recipientCount: 1,
        elapsedMs: 1,
        cpuUserMs: 1,
        cpuSystemMs: 0,
        heapUsedDelta: 10,
        actionCount: 8,
        actionCounts: { 'activitypub.outbox.post': 1 },
        categoryCounts: { activitypub: 1 },
        fuseki: { requestCount: 3, pathCounts: { '/$/datasets/alice': 2 } },
        errors: []
      }
    ]);

    expect(summary.complete).toBe(false);
    expect(summary.missingRecipientCounts).toEqual([10, 100, 200, 1000]);
    expect(summary.historicalTopLevelModel.status).toBe('insufficient-measurements');
    expect(summary.cases[1].fusekiPathCounts['/$/datasets/alice']).toBe(2);
  });

  test('failed traces are reported but cannot satisfy the completion gate or influence fitted models', () => {
    const records = REQUIRED_RECIPIENT_COUNTS.map(recipientCount => ({
      phase: 'APDM-P8-A',
      recipientCount,
      elapsedMs: recipientCount,
      cpuUserMs: 1,
      cpuSystemMs: 0,
      heapUsedDelta: 1,
      actionCount: 999999,
      actionCounts: { broken: 999999 },
      categoryCounts: { other: 999999 },
      fuseki: { requestCount: 999999, pathCounts: { '/$/datasets/broken': 999999 } },
      errors: [{ source: 'root-action', message: 'failed' }]
    }));

    const summary = summarize(records);
    expect(summary.complete).toBe(false);
    expect(summary.missingRecipientCounts).toEqual(REQUIRED_RECIPIENT_COUNTS);
    expect(summary.measuredModels.nestedMoleculerActions).toBeUndefined();
    expect(summary.measuredModels.fusekiHttpRequests).toBeUndefined();
    expect(summary.cases[1].successfulSamples).toBe(0);
    expect(summary.cases[1].failedSamples).toBe(1);
    expect(summary.cases[1].fusekiPathCounts).toEqual({});
  });

  test('successful samples drive models while failed samples remain separately reported', () => {
    const records = [];
    for (const recipientCount of REQUIRED_RECIPIENT_COUNTS) {
      records.push({
        phase: 'APDM-P8-A',
        recipientCount,
        elapsedMs: recipientCount,
        cpuUserMs: recipientCount / 2,
        cpuSystemMs: recipientCount / 4,
        heapUsedDelta: recipientCount * 100,
        actionCount: 6 * recipientCount + 2,
        actionCounts: {
          'activitypub.outbox.post': 1,
          'ldp.remote.store': recipientCount
        },
        categoryCounts: {
          activitypub: 1,
          ldp: recipientCount
        },
        fuseki: {
          requestCount: 4 * recipientCount + 1,
          pathCounts: { '/$/datasets/alice': recipientCount, '/alice/query': 3 * recipientCount + 1 }
        },
        errors: []
      });
      records.push({
        phase: 'APDM-P8-A',
        recipientCount,
        elapsedMs: 1,
        actionCount: 1000000,
        actionCounts: { broken: 1000000 },
        categoryCounts: { other: 1000000 },
        fuseki: { requestCount: 1000000, pathCounts: { '/$/datasets/broken': 1000000 } },
        errors: [{ source: 'detached-local-delivery', message: 'failed sample' }]
      });
    }

    const summary = summarize(records);
    expect(summary.complete).toBe(true);
    expect(summary.missingRecipientCounts).toEqual([]);
    expect(summary.measuredModels.nestedMoleculerActions.slope).toBeCloseTo(6, 8);
    expect(summary.measuredModels.nestedMoleculerActions.intercept).toBeCloseTo(2, 8);
    expect(summary.measuredModels.fusekiHttpRequests.slope).toBeCloseTo(4, 8);
    expect(summary.measuredModels.fusekiHttpRequests.intercept).toBeCloseTo(1, 8);
    expect(summary.historicalTopLevelModel.status).toBe('ready-for-reconciliation');
    expect(summary.cases[100].successfulSamples).toBe(1);
    expect(summary.cases[100].failedSamples).toBe(1);
    expect(summary.cases[100].fusekiPathCounts['/$/datasets/alice']).toBe(100);
    expect(summary.cases[100].fusekiPathCounts['/$/datasets/broken']).toBeUndefined();
  });
});
