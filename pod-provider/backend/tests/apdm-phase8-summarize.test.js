'use strict';

const {
  MIN_MEASURED_SAMPLES,
  REQUIRED_RECIPIENT_COUNTS,
  aggregateNestedCounts,
  linearFit,
  parseJsonLines,
  percentile,
  summarize
} = require('../scripts/apdm-phase8-summarize');

describe('APDM Phase 8 measurement summarizer', () => {
  test('uses the required recipient sizes and canonical sample floor', () => {
    expect(REQUIRED_RECIPIENT_COUNTS).toEqual([1, 10, 100, 200, 1000]);
    expect(MIN_MEASURED_SAMPLES).toBe(3);
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
    const model = linearFit([{ x: 1, y: 8 }, { x: 10, y: 62 }, { x: 100, y: 602 }]);
    expect(model.slope).toBeCloseTo(6, 8);
    expect(model.intercept).toBeCloseTo(2, 8);
  });

  test('aggregates nested Fuseki evidence without changing the original trace schema', () => {
    expect(aggregateNestedCounts([
      { fuseki: { pathCounts: { '/$/datasets/:dataset': 2, '/:dataset/query': 1 } } },
      { fuseki: { pathCounts: { '/$/datasets/:dataset': 3, '/:dataset/query': 4 } } }
    ], 'fuseki', 'pathCounts')).toEqual({ '/$/datasets/:dataset': 5, '/:dataset/query': 5 });
  });

  test('one successful sample is insufficient for Phase 8 completion', () => {
    const summary = summarize([{
      phase: 'APDM-P8-A', recipientCount: 1, elapsedMs: 1, cpuUserMs: 1, cpuSystemMs: 0,
      heapUsedDelta: 10, actionCount: 8, actionCounts: { 'activitypub.outbox.post': 1 },
      categoryCounts: { activitypub: 1 }, fuseki: { requestCount: 3, pathCounts: { '/$/datasets/:dataset': 2 } }, errors: []
    }]);
    expect(summary.complete).toBe(false);
    expect(summary.missingRecipientCounts).toEqual(REQUIRED_RECIPIENT_COUNTS);
    expect(summary.cases[1].successfulSamples).toBe(1);
    expect(summary.historicalTopLevelModel.status).toBe('insufficient-measurements');
  });

  test('failed traces cannot satisfy completion or influence fitted models', () => {
    const records = REQUIRED_RECIPIENT_COUNTS.map(recipientCount => ({
      phase: 'APDM-P8-A', recipientCount, elapsedMs: recipientCount, cpuUserMs: 1, cpuSystemMs: 0,
      heapUsedDelta: 1, actionCount: 999999, actionCounts: { broken: 999999 }, categoryCounts: { other: 999999 },
      fuseki: { requestCount: 999999, pathCounts: { '/$/datasets/:dataset': 999999 } }, errors: [{ source: 'root-action', name: 'Error' }]
    }));
    const summary = summarize(records);
    expect(summary.complete).toBe(false);
    expect(summary.missingRecipientCounts).toEqual(REQUIRED_RECIPIENT_COUNTS);
    expect(summary.measuredModels.nestedMoleculerActions).toBeUndefined();
    expect(summary.measuredModels.fusekiHttpRequests).toBeUndefined();
  });

  test('requires three successful samples per N while keeping failed samples separately reported', () => {
    const records = [];
    for (const recipientCount of REQUIRED_RECIPIENT_COUNTS) {
      for (let sample = 0; sample < MIN_MEASURED_SAMPLES; sample += 1) {
        records.push({
          phase: 'APDM-P8-A', recipientCount, elapsedMs: recipientCount, cpuUserMs: recipientCount / 2,
          cpuSystemMs: recipientCount / 4, heapUsedDelta: recipientCount * 100, actionCount: 6 * recipientCount + 2,
          actionCounts: { 'activitypub.outbox.post': 1, 'ldp.remote.store': recipientCount },
          categoryCounts: { activitypub: 1, ldp: recipientCount },
          fuseki: { requestCount: 4 * recipientCount + 1, pathCounts: { '/$/datasets/:dataset': recipientCount, '/:dataset/query': 3 * recipientCount + 1 } },
          errors: []
        });
      }
      records.push({
        phase: 'APDM-P8-A', recipientCount, elapsedMs: 1, actionCount: 1000000,
        actionCounts: { broken: 1000000 }, categoryCounts: { other: 1000000 },
        fuseki: { requestCount: 1000000, pathCounts: { '/$/datasets/:dataset': 1000000 } },
        errors: [{ source: 'detached-local-delivery', name: 'Error' }]
      });
    }
    const summary = summarize(records);
    expect(summary.complete).toBe(true);
    expect(summary.missingRecipientCounts).toEqual([]);
    expect(summary.measuredModels.nestedMoleculerActions.slope).toBeCloseTo(6, 8);
    expect(summary.measuredModels.nestedMoleculerActions.intercept).toBeCloseTo(2, 8);
    expect(summary.measuredModels.fusekiHttpRequests.slope).toBeCloseTo(4, 8);
    expect(summary.measuredModels.fusekiHttpRequests.intercept).toBeCloseTo(1, 8);
    expect(summary.cases[100].successfulSamples).toBe(3);
    expect(summary.cases[100].failedSamples).toBe(1);
  });
});
