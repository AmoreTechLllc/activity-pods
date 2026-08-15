const { ServiceBroker } = require('moleculer');

describe('internal-identity-projection', () => {
  let broker;
  let getByDid;
  let getByHandle;
  let getByCanonicalAccountId;

  beforeAll(async () => {
    broker = new ServiceBroker({ logger: false });

    getByCanonicalAccountId = jest.fn(async ctx => ({
      canonicalAccountId: ctx.params.canonicalAccountId,
      webId: ctx.params.canonicalAccountId,
      atprotoDid: 'did:plc:alice123',
      atprotoHandle: 'alice.test',
      atSigningKeyRef: 'key:commit',
      atRotationKeyRef: 'key:rotation',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }));
    getByDid = jest.fn(async ctx => ({
      canonicalAccountId: 'http://localhost:3000/alice/profile/card#me',
      webId: 'http://localhost:3000/alice/profile/card#me',
      atprotoDid: ctx.params.atprotoDid,
      atprotoHandle: 'alice.test',
      atSigningKeyRef: 'key:commit',
      atRotationKeyRef: 'key:rotation',
      status: 'active'
    }));
    getByHandle = jest.fn(async ctx => ({
      canonicalAccountId: 'http://localhost:3000/bob/profile/card#me',
      webId: 'http://localhost:3000/bob/profile/card#me',
      atprotoDid: 'did:plc:bob123',
      atprotoHandle: ctx.params.atprotoHandle,
      atSigningKeyRef: 'key:commit',
      atRotationKeyRef: 'key:rotation',
      status: 'active'
    }));

    broker.createService({
      name: 'identitybindings',
      actions: {
        getByCanonicalAccountId,
        getByDid,
        getByHandle
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
    expect(getByCanonicalAccountId).toHaveBeenCalledTimes(1);
  });

  test('delegates DID resolution once to the authoritative identitybindings lookup', async () => {
    const result = await broker.call('internal-identity-projection.getByDid', {
      atprotoDid: ' did:plc:alice123 '
    });

    expect(result.atprotoDid).toBe('did:plc:alice123');
    expect(getByDid).toHaveBeenCalledTimes(1);
    expect(getByDid.mock.calls[0][0].params).toEqual({ atprotoDid: 'did:plc:alice123' });
    expect(getByCanonicalAccountId).not.toHaveBeenCalled();
  });

  test('delegates normalized handle resolution once to identitybindings', async () => {
    const result = await broker.call('internal-identity-projection.getByHandle', {
      atprotoHandle: ' BOB.TEST '
    });

    expect(result.atprotoHandle).toBe('bob.test');
    expect(getByHandle).toHaveBeenCalledTimes(1);
    expect(getByHandle.mock.calls[0][0].params).toEqual({ atprotoHandle: 'bob.test' });
    expect(getByCanonicalAccountId).not.toHaveBeenCalled();
  });

  test('returns null for not-found identitybindings results without a second lookup path', async () => {
    getByDid.mockImplementationOnce(async () => null);

    const result = await broker.call('internal-identity-projection.getByDid', {
      atprotoDid: 'did:plc:missing'
    });

    expect(result).toBeNull();
    expect(getByDid).toHaveBeenCalledTimes(1);
    expect(getByCanonicalAccountId).not.toHaveBeenCalled();
  });

  test('does not mask an infrastructure failure carrying a misleading NOT_FOUND type', async () => {
    const infrastructureFailure = Object.assign(new Error('settings/LDP unavailable'), {
      code: 503,
      type: 'NOT_FOUND'
    });
    getByDid.mockImplementationOnce(async () => {
      throw infrastructureFailure;
    });

    await expect(
      broker.call('internal-identity-projection.getByDid', { atprotoDid: 'did:plc:error' })
    ).rejects.toMatchObject({ code: 503 });
    expect(getByDid).toHaveBeenCalledTimes(1);
    expect(getByCanonicalAccountId).not.toHaveBeenCalled();
  });

  test('does not depend directly on triplestore', () => {
    const schema = require('../services/internal-identity-projection.service');
    expect(schema.dependencies).toEqual(['identitybindings']);
    expect(schema.methods.lookupIndexedBinding).toBeUndefined();
    expect(schema.methods.readQueryBinding).toBeUndefined();
  });
});
