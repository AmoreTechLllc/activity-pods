const { ServiceBroker } = require('moleculer');
const {
  buildIncrementalIdentityBindingQuery,
  encodeCursor
} = require('../lib/identitybinding-index-query');

function row(value) {
  return { value };
}

describe('internal identity change scalability', () => {
  test('pushes cursor ordering and limit into SPARQL', () => {
    const since = encodeCursor({
      updatedAt: '2026-08-14T20:00:00.000Z',
      canonicalAccountId: 'https://pod.example/alice/profile/card#me'
    });
    const query = buildIncrementalIdentityBindingQuery({ since, limit: 250 });

    expect(query).toContain('apods:canonicalAccountId ?canonicalAccountId');
    expect(query).toContain('apods:updatedAt ?updatedAt');
    expect(query).toContain('FILTER(');
    expect(query).toContain('STR(?updatedAt) > "2026-08-14T20:00:00.000Z"');
    expect(query).toContain('STR(?canonicalAccountId) > "https://pod.example/alice/profile/card#me"');
    expect(query).toContain('ORDER BY STR(?updatedAt) STR(?canonicalAccountId)');
    expect(query).toContain('LIMIT 250');
  });

  test('caps the backend query at 500 rows', () => {
    const query = buildIncrementalIdentityBindingQuery({ since: null, limit: 10000 });
    expect(query).toContain('LIMIT 500');
  });

  test('queries the bounded settings index without calling the legacy full-list path', async () => {
    const broker = new ServiceBroker({ logger: false });
    const legacyList = jest.fn();
    const triplestoreQuery = jest.fn(async () => [
      {
        binding: row('urn:identitybindingindex:alice'),
        canonicalAccountId: row('https://pod.example/alice/profile/card#me'),
        webId: row('https://pod.example/alice/profile/card#me'),
        atprotoDid: row('did:plc:alice'),
        atprotoHandle: row('alice.example'),
        status: row('active'),
        repoInitialized: row('true'),
        updatedAt: row('2026-08-14T20:00:00.000Z'),
        createdAt: row('2026-08-14T19:00:00.000Z')
      }
    ]);

    broker.createService({
      name: 'identitybindings',
      actions: { list: legacyList }
    });
    broker.createService({
      name: 'triplestore',
      actions: { query: triplestoreQuery }
    });
    broker.createService(require('../services/internal-identity-changes.service'));
    await broker.start();

    try {
      const result = await broker.call('internal-identity-changes.listChanges', { limit: 25 });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].atprotoDid).toBe('did:plc:alice');
      expect(result.items[0].repo.initialized).toBe(true);
      expect(result.nextCursor).toEqual(expect.any(String));
      expect(triplestoreQuery).toHaveBeenCalledTimes(1);
      expect(triplestoreQuery.mock.calls[0][0].query).toContain('LIMIT 25');
      expect(legacyList).not.toHaveBeenCalled();
    } finally {
      await broker.stop();
    }
  });

  test('falls back to identitybindings.list only when the bounded index query fails', async () => {
    const broker = new ServiceBroker({ logger: false });
    const legacyList = jest.fn(async () => ({
      items: [
        {
          canonicalAccountId: 'https://pod.example/bob/profile/card#me',
          webId: 'https://pod.example/bob/profile/card#me',
          atprotoDid: 'did:plc:bob',
          atprotoHandle: 'bob.example',
          status: 'active',
          repoInitialized: false,
          updatedAt: '2026-08-14T21:00:00.000Z'
        }
      ],
      nextCursor: 'legacy-cursor'
    }));

    broker.createService({ name: 'identitybindings', actions: { list: legacyList } });
    broker.createService({
      name: 'triplestore',
      actions: { query: async () => { throw new Error('settings query unavailable'); } }
    });
    broker.createService(require('../services/internal-identity-changes.service'));
    await broker.start();

    try {
      const result = await broker.call('internal-identity-changes.listChanges', { limit: 50 });
      expect(result.items[0].atprotoDid).toBe('did:plc:bob');
      expect(result.nextCursor).toBe('legacy-cursor');
      expect(legacyList).toHaveBeenCalledTimes(1);
    } finally {
      await broker.stop();
    }
  });

  test('rejects malformed cursors before either query path runs', async () => {
    const broker = new ServiceBroker({ logger: false });
    const legacyList = jest.fn();
    const triplestoreQuery = jest.fn();

    broker.createService({ name: 'identitybindings', actions: { list: legacyList } });
    broker.createService({ name: 'triplestore', actions: { query: triplestoreQuery } });
    broker.createService(require('../services/internal-identity-changes.service'));
    await broker.start();

    try {
      await expect(
        broker.call('internal-identity-changes.listChanges', { since: 'not-a-cursor' })
      ).rejects.toMatchObject({ code: 400, type: 'INVALID_CURSOR' });
      expect(triplestoreQuery).not.toHaveBeenCalled();
      expect(legacyList).not.toHaveBeenCalled();
    } finally {
      await broker.stop();
    }
  });
});
