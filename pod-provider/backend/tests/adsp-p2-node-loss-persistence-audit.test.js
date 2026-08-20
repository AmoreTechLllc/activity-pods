'use strict';

const {
  auditPersistence,
  buildMarkerQuery,
  collectOutcomeExpectations,
  datasetQueryUrl
} = require('../scripts/adsp-p2-node-loss-persistence-audit');

function fakeResponse(count, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return { results: { bindings: [{ count: { value: String(count) } }] } };
    },
    async text() {
      return 'failure';
    }
  };
}

describe('ADSP P2 node-loss persistence audit', () => {
  const result = {
    faultBurst: {
      accepted: [{ requestId: 'fault-accepted' }],
      rejected: [{ requestId: 'fault-rejected' }]
    },
    recovery: { results: [{ requestId: 'recovery-1' }] },
    rejoin: { results: [{ requestId: 'rejoin-1' }] }
  };

  test('builds an exact request-marker SPARQL query', () => {
    const query = buildMarkerQuery('request-123');
    expect(query).toContain('COUNT(DISTINCT ?subject)');
    expect(query).toContain('ADSP P2 node-loss request-123');
    expect(query).toContain('GRAPH ?graph');
    expect(query).toContain('STR(?value) =');
  });

  test('collects accepted and rejected cardinality contracts without duplicates', () => {
    expect(collectOutcomeExpectations(result)).toEqual([
      { requestId: 'fault-accepted', callerOutcome: 'accepted', minCount: 1, maxCount: 1 },
      { requestId: 'recovery-1', callerOutcome: 'accepted', minCount: 1, maxCount: 1 },
      { requestId: 'rejoin-1', callerOutcome: 'accepted', minCount: 1, maxCount: 1 },
      { requestId: 'fault-rejected', callerOutcome: 'rejected', minCount: 0, maxCount: 1 }
    ]);
    expect(() => collectOutcomeExpectations({
      faultBurst: { accepted: [{ requestId: 'same' }], rejected: [{ requestId: 'same' }] }
    })).toThrow(/Duplicate node-loss requestId/u);
  });

  test('constructs a bounded dataset query URL and rejects path injection', () => {
    expect(datasetQueryUrl('http://fuseki_test:3030/', 'alice')).toBe('http://fuseki_test:3030/alice/query');
    expect(() => datasetQueryUrl('http://fuseki_test:3030/', '../admin')).toThrow(/Unsafe Fuseki dataset identifier/u);
  });

  test('requires every accepted request exactly once and permits rejected zero-or-once', async () => {
    const counts = new Map([
      ['fault-accepted', 1],
      ['recovery-1', 1],
      ['rejoin-1', 1],
      ['fault-rejected', 1]
    ]);
    const fetchImpl = jest.fn(async (_url, options) => {
      const body = new URLSearchParams(options.body);
      const query = body.get('query');
      const requestId = [...counts.keys()].find(id => query.includes(id));
      return fakeResponse(counts.get(requestId));
    });

    const audit = await auditPersistence({ result, dataset: 'alice', fetchImpl });
    expect(audit.passed).toBe(true);
    expect(audit.requestCount).toBe(4);
    expect(audit.ambiguousPersistedRejectedCount).toBe(1);
    expect(audit.duplicatePersistedMutationCount).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  test('fails when an accepted request disappears or any request is persisted twice', async () => {
    const counts = new Map([
      ['fault-accepted', 0],
      ['recovery-1', 1],
      ['rejoin-1', 1],
      ['fault-rejected', 2]
    ]);
    const fetchImpl = jest.fn(async (_url, options) => {
      const query = new URLSearchParams(options.body).get('query');
      const requestId = [...counts.keys()].find(id => query.includes(id));
      return fakeResponse(counts.get(requestId));
    });

    const audit = await auditPersistence({ result, dataset: 'alice', fetchImpl });
    expect(audit.passed).toBe(false);
    expect(audit.failures).toHaveLength(2);
    expect(audit.duplicatePersistedMutationCount).toBe(1);
  });
});
