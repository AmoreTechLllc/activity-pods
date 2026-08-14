'use strict';

const {
  REQUIRED_RECIPIENT_COUNTS,
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

  test('does not declare Phase 8 measurement complete until every required size exists', () => {
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
        fuseki: { requestCount: 3 },
        errors: []
      }
    ]);

    expect(summary.complete).toBe(false);
    expect(summary.missingRecipientCounts).toEqual([10, 100, 200, 1000]);
    expect(summary.historicalTopLevelModel.status).toBe('insufficient-measurements');
  });

  test('reconciles measured nested-action and Fuseki slopes once all sizes are present', () => {
    const records = REQUIRED_RECIPIENT_COUNTS.map(recipientCount => ({
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
      fuseki: { requestCount: 4 * recipientCount + 1 },
      errors: []
    }));

    const summary = summarize(records);
    expect(summary.complete).toBe(true);
    expect(summary.missingRecipientCounts).toEqual([]);
    expect(summary.measuredModels.nestedMoleculerActions.slope).toBeCloseTo(6, 8);
    expect(summary.measuredModels.nestedMoleculerActions.intercept).toBeCloseTo(2, 8);
    expect(summary.measuredModels.fusekiHttpRequests.slope).toBeCloseTo(4, 8);
    expect(summary.measuredModels.fusekiHttpRequests.intercept).toBeCloseTo(1, 8);
    expect(summary.historicalTopLevelModel.status).toBe('ready-for-reconciliation');
  });
});
