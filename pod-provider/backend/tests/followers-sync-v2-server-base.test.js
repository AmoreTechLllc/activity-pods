'use strict';

const schema = require('../services/internal-followers-sync-v2-api.service');

function createService(overrides = {}) {
  return {
    settings: schema.settings,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    ...schema.methods,
    ...overrides
  };
}

function createContext(params, overrides = {}) {
  return {
    params,
    meta: {},
    call: jest.fn(),
    ...overrides
  };
}

describe('FEP-8fcf v2 server-base authority contract', () => {
  test('filters same-host candidates by scheme and port rather than hostname alone', async () => {
    const service = createService({
      findActorByIdentifier: jest.fn(async () => ({
        id: 'https://pods.example/users/alice',
        followers: 'https://pods.example/users/alice/followers'
      }))
    });
    const ctx = createContext({
      actorIdentifier: 'alice',
      baseUri: 'https://remote.example:8443/'
    });
    ctx.call.mockImplementation(async (action, params) => {
      expect(action).toBe('activitypub.follower-domain-index.getForDomain');
      expect(params).toEqual({
        collectionUri: 'https://pods.example/users/alice/followers',
        domain: 'remote.example'
      });
      return [
        'https://remote.example:8443/users/bob',
        'https://remote.example/users/default-port',
        'http://remote.example:8443/users/plain-http',
        'https://remote.example:8443/users/charlie'
      ];
    });

    const result = await schema.actions.getPartialCollection.handler.call(service, ctx);

    expect(ctx.meta.$statusCode).toBe(200);
    expect(result).toEqual({
      followers: [
        'https://remote.example:8443/users/bob',
        'https://remote.example:8443/users/charlie'
      ]
    });
  });

  test('normalizes a valid root server base URI and preserves explicit ports', () => {
    const service = createService();

    expect(service.normalizeServerBaseUri('HTTPS://Remote.Example:8443/')).toBe(
      'https://remote.example:8443/'
    );
    expect(service.normalizeServerBaseUri('https://remote.example/')).toBe(
      'https://remote.example/'
    );
  });

  test('rejects credentials, non-root paths, query strings and non-http schemes', async () => {
    const service = createService();
    const badValues = [
      'https://user:pass@remote.example/',
      'https://remote.example/social/',
      'https://remote.example/?page=1',
      'ftp://remote.example/'
    ];

    for (const baseUri of badValues) {
      const ctx = createContext({ actorIdentifier: 'alice', baseUri });
      const result = await schema.actions.getPartialCollection.handler.call(service, ctx);
      expect(ctx.meta.$statusCode).toBe(400);
      expect(result.error).toBe('invalid_request');
    }
  });

  test('fails closed if the domain projection returns malformed actor data', async () => {
    const service = createService({
      findActorByIdentifier: jest.fn(async () => ({
        followers: 'https://pods.example/users/alice/followers'
      }))
    });
    const ctx = createContext({
      actorIdentifier: 'alice',
      baseUri: 'https://remote.example/'
    });
    ctx.call.mockResolvedValue(['https://remote.example/users/bob', 'not-a-uri']);

    const result = await schema.actions.getPartialCollection.handler.call(service, ctx);

    expect(ctx.meta.$statusCode).toBe(500);
    expect(result.error).toBe('internal_error');
  });

  test('preserves a legitimate empty authoritative partial collection', async () => {
    const service = createService({
      findActorByIdentifier: jest.fn(async () => ({
        followers: 'https://pods.example/users/alice/followers'
      }))
    });
    const ctx = createContext({
      actorIdentifier: 'alice',
      baseUri: 'https://remote.example/'
    });
    ctx.call.mockResolvedValue([]);

    const result = await schema.actions.getPartialCollection.handler.call(service, ctx);

    expect(ctx.meta.$statusCode).toBe(200);
    expect(result).toEqual({ followers: [] });
  });

  test('uses constant-time token comparison only for equal-length values', () => {
    const service = createService();

    expect(service.safeTokenEquals('secret-token', 'secret-token')).toBe(true);
    expect(service.safeTokenEquals('secret-token', 'wrong-token!')).toBe(false);
    expect(service.safeTokenEquals('secret-token', 'short')).toBe(false);
    expect(service.safeTokenEquals('', '')).toBe(false);
  });
});
