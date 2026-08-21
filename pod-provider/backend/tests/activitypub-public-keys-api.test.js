'use strict';

const crypto = require('crypto');
const service = require('../services/core/activitypub-public-keys.service');

const ACTOR = 'https://activitypods.example/alice';
const KEY_ID = `${ACTOR}/keys/main`;
const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' });

function context({ publicKey = {}, rows } = {}) {
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
      if (action === 'triplestore.query') {
        expect(params).toEqual(expect.objectContaining({
          accept: 'application/sparql-results+json',
          dataset: 'alice',
          webId: 'system'
        }));
        expect(params.query).toContain(`<${KEY_ID}> sec:owner ?owner`);
        return rows || [{
          owner: { value: ACTOR },
          controller: { value: ACTOR },
          publicKeyPem: { value: PUBLIC_KEY_PEM }
        }];
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
    { publicKey: { id: `${ACTOR}/keys/other` } },
    { rows: [{ owner: { value: 'https://activitypods.example/mallory' }, controller: { value: ACTOR }, publicKeyPem: { value: PUBLIC_KEY_PEM } }] },
    { rows: [{ owner: { value: ACTOR }, controller: { value: 'https://activitypods.example/mallory' }, publicKeyPem: { value: PUBLIC_KEY_PEM } }] },
    { rows: [{ owner: { value: ACTOR }, controller: { value: ACTOR }, publicKeyPem: { value: 'not a public key' } }] },
    { rows: [] },
    { rows: [{ owner: { value: ACTOR }, controller: { value: ACTOR }, publicKeyPem: { value: PUBLIC_KEY_PEM } }, { owner: { value: ACTOR }, controller: { value: ACTOR }, publicKeyPem: { value: PUBLIC_KEY_PEM } }] }
  ])('returns no key document for mismatched or invalid material (%p)', async fixture => {
    await expect(service.actions.get.handler(context(fixture))).rejects.toMatchObject({ code: 404 });
  });
});
