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
    victimRootEntry: { requestId: 'fault-rejected' },
    faultBurst: {
      accepted: [{ requestId: 'fault-accepted' }],
      rejected: [{ requestId: 'fault-rejected' }, { requestId: 'fault-rejected-other' }]
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

  test('makes the held victim commit exactly-once while keeping other rejections zero-or-once', () => {
    expect(collectOutcomeExpectations(result)).toEqual([
      { requestId: 'fault-accepted', callerOutcome: 'accepted', targetedAmbiguousCommit: false, minCount: 1, maxCount: 1 },
      { requestId: 'recovery-1', callerOutcome: 'accepted', targetedAmbiguousCommit: false, minCount: 1, maxCount: 1 },
      { requestId: 'rejoin-1', callerOutcome: 'accepted', targetedAmbiguousCommit: false, minCount: 1, maxCount: 1 },
      { requestId: 'fault-rejected', callerOutcome: 'rejected', targetedAmbiguousCommit: true, minCount: 1, maxCount: 1 },
      { requestId: 'fault-rejected-other', callerOutcome: 'rejected', targetedAmbiguousCommit: false, minCount: 0, maxCount: 1 }
    ]);
    expect(() => collectOutcomeExpectations({
      victimRootEntry: { requestId: 'same' },
      faultBurst: { accepted: [{ requestId: 'same' }], rejected: [{ requestId: 'same' }] }
    })).toThrow(/Duplicate node-loss requestId/u);
  });

  test('fails closed when the victim request is absent from all outcomes', () => {
    expect(() => collectOutcomeExpectations({
      victimRootEntry: { requestId: 'missing-target' },
      faultBurst: { accepted: [{ requestId: 'different' }], rejected: [] }
    })).toThrow(/exactly one targeted ambiguous request outcome/u);
  });

  test('constructs a bounded dataset query URL and rejects path injection', () => {
    expect(datasetQueryUrl('http://fuseki_test:3030/', 'alice')).toBe('http://fuseki_test:3030/alice/query');
    expect(() => datasetQueryUrl('http://fuseki_test:3030/', '../admin')).toThrow(/Unsafe Fuseki dataset identifier/u);
  });

  test('requires accepted and targeted ambiguous mutations exactly once', async () => {
    const counts = new Map([
      ['fault-accepted', 1],
      ['recovery-1', 1],
      ['rejoin-1', 1],
      ['fault-rejected', 1],
      ['fault-rejected-other', 0]
    ]);
    const fetchImpl = jest.fn(async (_url, options) => {
      const body = new URLSearchParams(options.body);
      const query = body.get('query');
      const requestId = [...counts.keys()].find(id => query.includes(id));
      return fakeResponse(counts.get(requestId));
    });

    const audit = await auditPersistence({ result, dataset: 'alice', fetchImpl });
    expect(audit.passed).toBe(true);
    expect(audit.requestCount).toBe(5);
    expect(audit.targetedAmbiguousRequestId).toBe('fault-rejected');
    expect(audit.targetedAmbiguousCallerOutcome).toBe('rejected');
    expect(audit.targetedAmbiguousCommitPersistedExactlyOnce).toBe(true);
    expect(audit.ambiguousPersistedRejectedCount).toBe(1);
    expect(audit.duplicatePersistedMutationCount).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  test('fails when the targeted ambiguous commit disappears or any request is persisted twice', async () => {
    const counts = new Map([
      ['fault-accepted', 1],
      ['recovery-1', 1],
      ['rejoin-1', 1],
      ['fault-rejected', 0],
      ['fault-rejected-other', 2]
    ]);
    const fetchImpl = jest.fn(async (_url, options) => {
      const query = new URLSearchParams(options.body).get('query');
      const requestId = [...counts.keys()].find(id => query.includes(id));
      return fakeResponse(counts.get(requestId));
    });

    const audit = await auditPersistence({ result, dataset: 'alice', fetchImpl });
    expect(audit.passed).toBe(false);
    expect(audit.targetedAmbiguousCommitPersistedExactlyOnce).toBe(false);
    expect(audit.failures).toHaveLength(2);
    expect(audit.duplicatePersistedMutationCount).toBe(1);
  });
});
