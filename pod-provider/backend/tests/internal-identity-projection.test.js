const { ServiceBroker } = require('moleculer');

describe('internal-identity-projection', () => {
  let broker;
  let triplestoreQuery;
  let getByDid;
  let getByHandle;
  let getByCanonicalAccountId;

  beforeAll(async () => {
    broker = new ServiceBroker({ logger: false });

    getByCanonicalAccountId = jest.fn(async ctx => ({
      canonicalAccountId: ctx.params.canonicalAccountId,
      webId: ctx.params.canonicalAccountId,
      atprotoDid: ctx.params.canonicalAccountId.includes('bob') ? 'did:plc:bob123' : 'did:plc:alice123',
      atprotoHandle: ctx.params.canonicalAccountId.includes('bob') ? 'bob.test' : 'alice.test',
      atSigningKeyRef: 'key:commit',
      atRotationKeyRef: 'key:rotation',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }));
    getByDid = jest.fn(async () => null);
    getByHandle = jest.fn(async () => null);

    broker.createService({
      name: 'identitybindings',
      actions: {
        getByCanonicalAccountId,
        getByDid,
        getByHandle
      }
    });

    triplestoreQuery = jest.fn(async ctx => {
      const query = ctx.params.query;
      if (query.includes('did:plc:alice123')) {
        return [{ canonicalAccountId: { value: 'http://localhost:3000/alice/profile/card#me' } }];
      }
      if (query.includes('bob.test')) {
        return [{ canonicalAccountId: { value: 'http://localhost:3000/bob/profile/card#me' } }];
      }
      return [];
    });

    broker.createService({
      name: 'triplestore',
      actions: {
        query: triplestoreQuery
      }
    });

    broker.createService(require('../services/internal-identity-projection.service'));

    await broker.start();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await broker.stop();
  });

  test('returns normalized DTO by canonicalAccountId', async () => {
    const result = await broker.call('internal-identity-projection.getByCanonicalAccountId', {
      canonicalAccountId: 'http://localhost:3000/alice/profile/card#me'
    });

    expect(result.canonicalAccountId).toBe('http://localhost:3000/alice/profile/card#me');
    expect(result.webId).toBe('http://localhost:3000/alice/profile/card#me');
    expect(result.atprotoDid).toBe('did:plc:alice123');
    expect(result.atprotoHandle).toBe('alice.test');
    expect(result.atSigningKeyRef).toBe('key:commit');
    expect(result.atRotationKeyRef).toBe('key:rotation');
    expect(result.status).toBe('active');
  });

  test('resolves DID through a predicate/object index query without population scan fallback', async () => {
    const result = await broker.call('internal-identity-projection.getByDid', {
      atprotoDid: 'did:plc:alice123'
    });

    expect(result.canonicalAccountId).toBe('http://localhost:3000/alice/profile/card#me');
    expect(result.atprotoDid).toBe('did:plc:alice123');
    expect(triplestoreQuery).toHaveBeenCalledTimes(1);
    const query = triplestoreQuery.mock.calls[0][0].params.query;
    expect(query).toContain('apods:atprotoDid "did:plc:alice123"');
    expect(query).toContain('apods:canonicalAccountId ?canonicalAccountId');
    expect(query).toContain('LIMIT 1');
    expect(query).not.toContain('ORDER BY');
    expect(getByDid).not.toHaveBeenCalled();
  });

  test('resolves normalized handle through the exact index before compatibility fallback', async () => {
    const result = await broker.call('internal-identity-projection.getByHandle', {
      atprotoHandle: 'BOB.TEST'
    });

    expect(result.canonicalAccountId).toBe('http://localhost:3000/bob/profile/card#me');
    expect(result.atprotoHandle).toBe('bob.test');
    const query = triplestoreQuery.mock.calls[0][0].params.query;
    expect(query).toContain('apods:atprotoHandle "bob.test"');
    expect(getByHandle).not.toHaveBeenCalled();
  });

  test('retains legacy DID fallback when the exact index has no match', async () => {
    getByDid.mockImplementationOnce(async ctx => ({
      canonicalAccountId: 'http://localhost:3000/legacy/profile/card#me',
      webId: 'http://localhost:3000/legacy/profile/card#me',
      atprotoDid: ctx.params.atprotoDid,
      atprotoHandle: 'legacy.test',
      atSigningKeyRef: 'key:commit',
      atRotationKeyRef: 'key:rotation',
      status: 'active'
    }));

    const result = await broker.call('internal-identity-projection.getByDid', {
      atprotoDid: 'did:plc:legacy'
    });

    expect(result.atprotoDid).toBe('did:plc:legacy');
    expect(getByDid).toHaveBeenCalledTimes(1);
  });

  test('escapes exact index values as SPARQL string literals', async () => {
    const hostile = 'did:plc:quote"\\newline\nvalue';
    await broker.call('internal-identity-projection.getByDid', { atprotoDid: hostile });

    const query = triplestoreQuery.mock.calls[0][0].params.query;
    expect(query).toContain(JSON.stringify(hostile));
    expect(getByDid).toHaveBeenCalledTimes(1);
  });
});
