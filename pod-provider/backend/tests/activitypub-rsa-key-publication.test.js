'use strict';

jest.mock('@semapps/crypto', () => ({ KeysService: {} }));

const { KEY_TYPES } = require('@semapps/crypto/constants');
const keysService = require('../services/core/keys');

const ACTOR_URI = 'https://activitypods.test/alice';
const PRIVATE_KEY_URI = `${ACTOR_URI}/data/private-key`;
const PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n';

describe('ActivityPub RSA key publication', () => {
  test('uses a stable actor fragment and emits a strict-id verification method', () => {
    const result = keysService.activityPubRsaVerificationMethodTriples(
      ACTOR_URI,
      PUBLIC_KEY_PEM,
      KEY_TYPES.RSA
    );

    expect(result.keyId).toBe(`${ACTOR_URI}#main-key`);
    expect(result.triples.map(item => [item.subject.value, item.predicate.value, item.object.value])).toEqual(
      expect.arrayContaining([
        [`${ACTOR_URI}#main-key`, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', KEY_TYPES.RSA],
        [`${ACTOR_URI}#main-key`, 'https://w3id.org/security#owner', ACTOR_URI],
        [`${ACTOR_URI}#main-key`, 'https://w3id.org/security#controller', ACTOR_URI],
        [`${ACTOR_URI}#main-key`, 'https://w3id.org/security#publicKeyPem', PUBLIC_KEY_PEM]
      ])
    );
  });

  test.each([
    'ftp://activitypods.test/alice',
    'https://user:password@activitypods.test/alice',
    'https://activitypods.test/alice#existing'
  ])('rejects unsafe or ambiguous actor URI %s', actorUri => {
    expect(() => keysService.activityPubRsaKeyId(actorUri)).toThrow(
      'credential-free HTTP(S) actor URI without a fragment'
    );
  });

  test('publishes RSA material into the actor document without a second public resource', async () => {
    const ctx = {
      params: {
        webId: ACTOR_URI,
        keyObject: { id: PRIVATE_KEY_URI, '@type': KEY_TYPES.RSA, publicKeyPem: PUBLIC_KEY_PEM }
      },
      meta: {},
      call: jest.fn().mockResolvedValue(undefined)
    };
    const service = {
      actions: {
        getPublicKeyObject: jest.fn().mockResolvedValue({
          '@type': KEY_TYPES.RSA,
          owner: ACTOR_URI,
          controller: ACTOR_URI,
          publicKeyPem: PUBLIC_KEY_PEM
        })
      }
    };

    const result = await keysService.actions.publishPublicKeyLocally.handler.call(service, ctx);

    expect(result).toBe(`${ACTOR_URI}#main-key`);
    expect(ctx.call).toHaveBeenCalledTimes(2);
    expect(ctx.call).not.toHaveBeenCalledWith('keys.public-container.post', expect.anything());
    expect(ctx.call.mock.calls[0][0]).toBe('ldp.resource.patch');
    expect(ctx.call.mock.calls[0][1]).toMatchObject({ resourceUri: ACTOR_URI, webId: ACTOR_URI });
    expect(ctx.call.mock.calls[1][1]).toMatchObject({ resourceUri: PRIVATE_KEY_URI, webId: ACTOR_URI });
    expect(ctx.call.mock.calls[1][1].triplesToAdd[0].object.value).toBe(`${ACTOR_URI}#main-key`);
  });

  test('fails closed when RSA material is not owned and controlled by the actor', async () => {
    const ctx = {
      params: { webId: ACTOR_URI, keyObject: { id: PRIVATE_KEY_URI } },
      meta: {},
      call: jest.fn()
    };
    const service = {
      actions: {
        getPublicKeyObject: jest.fn().mockResolvedValue({
          '@type': KEY_TYPES.RSA,
          owner: 'https://activitypods.test/mallory',
          controller: ACTOR_URI,
          publicKeyPem: PUBLIC_KEY_PEM
        })
      }
    };

    await expect(keysService.actions.publishPublicKeyLocally.handler.call(service, ctx)).rejects.toThrow(
      'must be owned and controlled by its actor'
    );
    expect(ctx.call).not.toHaveBeenCalled();
  });

  test('retains the SemApps public container for non-RSA keys', async () => {
    const ctx = {
      params: {
        webId: ACTOR_URI,
        keyObject: { id: PRIVATE_KEY_URI, '@type': 'urn:example:key', publicKeyMultibase: 'zTest' }
      },
      meta: {},
      call: jest
        .fn()
        .mockResolvedValueOnce(`${ACTOR_URI}/data/public-key`)
        .mockResolvedValueOnce(undefined)
    };
    const service = {
      actions: {
        getPublicKeyObject: jest.fn().mockResolvedValue({
          '@type': 'urn:example:key',
          controller: ACTOR_URI,
          publicKeyMultibase: 'zTest'
        })
      }
    };

    const result = await keysService.actions.publishPublicKeyLocally.handler.call(service, ctx);

    expect(result).toBe(`${ACTOR_URI}/data/public-key`);
    expect(ctx.call.mock.calls[0][0]).toBe('keys.public-container.post');
    expect(ctx.call.mock.calls[1][0]).toBe('ldp.resource.patch');
  });
});
