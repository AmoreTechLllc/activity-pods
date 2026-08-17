'use strict';

const {
  assertPrivacySafeRawArtifact,
  median,
  selectMeasuredRecords,
  summarizeCount,
  validateRecord
} = require('../scripts/apdm-phase11-summarize');

function query(overrides = {}) {
  return {
    caller: 'webacl.resource.hasRights',
    operation: 'select',
    shapeHash: 'a'.repeat(64),
    count: 3,
    errorCount: 0,
    totalDurationMs: 4.5,
    maxDurationMs: 2,
    ...overrides
  };
}

function record(overrides = {}) {
  const queries = overrides.queries || [query()];
  const totalQueryCalls = overrides.totalQueryCalls ?? queries.reduce((sum, item) => sum + item.count, 0);
  return {
    version: 1,
    phase: 'APDM-P11-A',
    requestId: 'apdm-p8-run-sample-1-deadbeef',
    caseLabel: 'real-local-10',
    recipientCount: 10,
    startedAt: '2026-08-17T00:00:00.000Z',
    finishedAt: '2026-08-17T00:00:01.000Z',
    totalQueryCalls,
    attributedQueryCalls: overrides.attributedQueryCalls ?? totalQueryCalls,
    unattributedQueryCalls: overrides.unattributedQueryCalls ?? 0,
    distinctAttributionKeys: queries.length,
    overflowed: false,
    droppedCalls: 0,
    queries,
    ...overrides
  };
}

function p8Record(requestId, queryCount = 3, overrides = {}) {
  return {
    version: 1,
    phase: 'APDM-P8-A',
    requestId,
    recipientCount: 10,
    actionCounts: { 'triplestore.query': queryCount },
    errors: [],
    ...overrides
  };
}

describe('APDM Phase 11 evidence summarizer', () => {
  test('median is deterministic for odd and even samples', () => {
    expect(median([9, 1, 5])).toBe(5);
    expect(median([4, 2, 8, 6])).toBe(5);
  });

  test('accepts safe aggregate JSON and rejects serialized URL or IRI syntax', () => {
    expect(() => assertPrivacySafeRawArtifact(JSON.stringify(record()), 'safe.jsonl')).not.toThrow();
    expect(() => assertPrivacySafeRawArtifact('{"value":"http' + '://example.invalid/resource"}', 'bad.jsonl')).toThrow(/Privacy scan rejected/u);
    expect(() => assertPrivacySafeRawArtifact('{"value":"<urn:test:resource>"}', 'bad.jsonl')).toThrow(/Privacy scan rejected/u);
  });

  test('rejects schema drift, overflow, unsafe metadata and opaque operations', () => {
    expect(() => validateRecord({ ...record(), unexpectedPayload: 'not-allowed' }, 10, 'record')).toThrow(/unexpected key/u);
    expect(() => validateRecord({ ...record(), overflowed: true, droppedCalls: 1 }, 10, 'record')).toThrow(/overflowed/u);
    expect(() => validateRecord({ ...record(), caseLabel: 'unexpected-case' }, 10, 'record')).toThrow(/caseLabel/u);
    expect(() => validateRecord(record({ queries: [query({ operation: 'unknown' })] }), 10, 'record')).toThrow(/opaque query shapes/u);
    expect(() => validateRecord(record({ queries: [query({ operation: 'invalid' })] }), 10, 'record')).toThrow(/unsupported/u);
  });

  test('joins only measured Phase 8 request IDs, excluding warmups', () => {
    const ids = [
      'apdm-p8-run-sample-1-deadbeef',
      'apdm-p8-run-sample-2-feedface',
      'apdm-p8-run-sample-3-c001d00d'
    ];
    const warmupId = 'apdm-p8-run-warmup-1-cafebabe';
    const p8 = ids.map(id => p8Record(id));
    const p11 = [
      record({ requestId: warmupId }),
      ...ids.map(id => record({ requestId: id }))
    ];
    const selected = selectMeasuredRecords(p8, p11, 10);
    expect(selected).toHaveLength(3);
    expect(selected.map(item => item.requestId)).toEqual(ids);
  });

  test('rejects incomplete or unattributed query lineage even when Phase 11 is internally consistent', () => {
    const ids = [
      'apdm-p8-run-sample-1-deadbeef',
      'apdm-p8-run-sample-2-feedface',
      'apdm-p8-run-sample-3-c001d00d'
    ];
    const p8 = ids.map(id => p8Record(id, 3));

    const incomplete = ids.map(id => record({
      requestId: id,
      queries: [query({ count: 2 })],
      totalQueryCalls: 2,
      attributedQueryCalls: 2
    }));
    expect(() => selectMeasuredRecords(p8, incomplete, 10)).toThrow(/does not match independent Phase 8/u);

    const unattributed = ids.map(id => record({
      requestId: id,
      queries: [query({ caller: 'unknown', count: 3 })],
      totalQueryCalls: 3,
      attributedQueryCalls: 0,
      unattributedQueryCalls: 3
    }));
    expect(() => selectMeasuredRecords(p8, unattributed, 10)).toThrow(/unattributed/u);
  });

  test('requires at least three measured samples', () => {
    const id = 'apdm-p8-run-sample-1-deadbeef';
    expect(() => selectMeasuredRecords([p8Record(id)], [record({ requestId: id })], 10)).toThrow(/at least 3/u);
  });

  test('summarizes per-shape sample medians and error totals', () => {
    const first = record({ queries: [query({ count: 2, totalDurationMs: 2, maxDurationMs: 1 })], totalQueryCalls: 2, attributedQueryCalls: 2 });
    const second = record({
      requestId: 'apdm-p8-run-sample-2-feedface',
      queries: [query({ count: 6, errorCount: 1, totalDurationMs: 8, maxDurationMs: 3 })],
      totalQueryCalls: 6,
      attributedQueryCalls: 6
    });
    const summary = summarizeCount(10, [first, second]);
    expect(summary.totalQueryCallsMedian).toBe(4);
    expect(summary.queries[0].medianCountPerSample).toBe(4);
    expect(summary.queries[0].medianDurationMsPerSample).toBe(5);
    expect(summary.queries[0].errorCount).toBe(1);
  });
});
