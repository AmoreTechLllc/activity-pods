'use strict';

const crypto = require('crypto');
const service = require('../services/core/activitypub-public-keys.service');

const ACTOR = 'https://activitypods.example/alice';
const KEY_ID = `${ACTOR}/keys/main`;
const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' });

function context(publicKey = {}) {
  return {
    params: { username: 'alice' },
    meta: {},
    call: jest.fn(async (action, params, options) => {
      if (action === 'auth.account.findByUsername') {
        expect(params).toEqual({ username: 'alice' });
        return { username: 'alice', webId: ACTOR };
      }
      if (action === 'activitypub.actor.get') {
        expect(params).toEqual({ actorUri: ACTOR, webId: 'system' });
        expect(options).toEqual({ meta: { dataset: 'alice', webId: 'system' } });
        return {
          id: ACTOR,
          publicKey: {
            id: KEY_ID,
            type: 'RsaVerificationKey2018',
            owner: ACTOR,
            controller: ACTOR,
            publicKeyPem: PUBLIC_KEY_PEM,
            ...publicKey
          }
        };
      }
      throw new Error(`Unexpected call ${action}`);
    })
  };
}

describe('public ActivityPub key document', () => {
  test('registers an explicitly unauthenticated read-only key route', async () => {
    const broker = { call: jest.fn() };
    await service.started.call({ broker });
    expect(broker.call).toHaveBeenCalledWith(
      'api.addRoute',
      expect.objectContaining({
        route: expect.objectContaining({
          path: '/:username([^/.][^/]+)/keys/main',
          authentication: false,
          authorization: false,
          aliases: { 'GET /': 'activitypub-public-keys.get' }
        }),
        toBottom: false
      })
    );
  });

  test('returns only the exact actor-owned RSA public verification method', async () => {
    const ctx = context();
    const result = await service.actions.get.handler(ctx);
    expect(result).toEqual({
      '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
      id: KEY_ID,
      type: 'RsaVerificationKey2018',
      owner: ACTOR,
      controller: ACTOR,
      publicKeyPem: PUBLIC_KEY_PEM
    });
    expect(ctx.meta.$responseType).toBe('application/activity+json');
    expect(ctx.meta.$responseHeaders).toEqual({ 'Cache-Control': 'no-store' });
  });

  test.each([
    { id: `${ACTOR}/keys/other` },
    { owner: 'https://activitypods.example/mallory' },
    { controller: 'https://activitypods.example/mallory' },
    { publicKeyPem: 'not a public key' }
  ])('returns no key document for mismatched or invalid material (%p)', async override => {
    await expect(service.actions.get.handler(context(override))).rejects.toMatchObject({ code: 404 });
  });
});
