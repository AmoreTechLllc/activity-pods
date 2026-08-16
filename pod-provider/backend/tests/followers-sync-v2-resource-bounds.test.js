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

function createContext(candidates) {
  return {
    params: {
      actorIdentifier: 'alice',
      baseUri: 'https://remote.example/'
    },
    meta: {},
    call: jest.fn(async action => {
      if (action === 'activitypub.follower-server-base-index.getForServerBaseUri') return candidates;
      throw new Error(`unexpected action ${action}`);
    })
  };
}

describe('FEP-8fcf v2 partial authority resource bounds', () => {
  test('rejects a complete partial collection above the 10k item ceiling without truncating it', async () => {
    const candidates = Array.from(
      { length: 10_001 },
      (_, index) => `https://remote.example/users/${index}`
    );
    const service = createService({
      findActorByIdentifier: jest.fn(async () => ({
        followers: 'https://pods.example/users/alice/followers'
      }))
    });
    const ctx = createContext(candidates);

    const result = await schema.actions.getPartialCollection.handler.call(service, ctx);

    expect(ctx.meta.$statusCode).toBe(503);
    expect(result.error).toBe('collection_too_large');
    expect(result.message).toContain('10000 entries');
    expect(result.followers).toBeUndefined();
  });

  test('rejects a partial response above the 2 MiB producer ceiling without truncating it', async () => {
    const padding = 'x'.repeat(3800);
    const candidates = Array.from(
      { length: 600 },
      (_, index) => `https://remote.example/users/${index}?padding=${padding}`
    );
    const service = createService({
      findActorByIdentifier: jest.fn(async () => ({
        followers: 'https://pods.example/users/alice/followers'
      }))
    });
    const ctx = createContext(candidates);

    const result = await schema.actions.getPartialCollection.handler.call(service, ctx);

    expect(ctx.meta.$statusCode).toBe(503);
    expect(result.error).toBe('collection_too_large');
    expect(result.message).toContain('2097152 bytes');
    expect(result.followers).toBeUndefined();
  });
});
