'use strict';

const crypto = require('crypto');
const { Errors: E } = require('moleculer-web');
const { activityPubRsaKeyId } = require('../../utils/activitypub-rsa-key-id');

function resourceId(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value.id || value['@id'] || null;
  return null;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

module.exports = {
  name: 'activitypub-public-keys',

  dependencies: ['api', 'auth.account', 'activitypub.actor'],

  async started() {
    await this.broker.call('api.addRoute', {
      route: {
        name: 'activitypub-public-key-document',
        path: '/:username([^/.][^/]+)/keys/main',
        authentication: false,
        authorization: false,
        aliases: {
          'GET /': 'activitypub-public-keys.get'
        }
      },
      toBottom: false
    });
  },

  actions: {
    get: {
      params: {
        username: { type: 'string', min: 1 }
      },
      async handler(ctx) {
        const account = await ctx.call('auth.account.findByUsername', { username: ctx.params.username });
        if (!account || typeof account.webId !== 'string' || !account.username) throw new E.NotFoundError();

        const actor = await ctx.call(
          'activitypub.actor.get',
          { actorUri: account.webId, webId: 'system' },
          { meta: { dataset: account.username, webId: 'system' } }
        );
        const expectedKeyId = activityPubRsaKeyId(account.webId);
        const matches = asArray(actor?.publicKey).filter(key => resourceId(key) === expectedKeyId);
        if (matches.length !== 1 || typeof matches[0]?.publicKeyPem !== 'string') throw new E.NotFoundError();

        let parsedKey;
        try {
          parsedKey = crypto.createPublicKey(matches[0].publicKeyPem);
        } catch {
          throw new E.NotFoundError();
        }
        if (parsedKey.asymmetricKeyType !== 'rsa') throw new E.NotFoundError();
        if (matches[0].owner !== account.webId || matches[0].controller !== account.webId) {
          throw new E.NotFoundError();
        }

        ctx.meta.$responseType = 'application/activity+json';
        ctx.meta.$responseHeaders = { 'Cache-Control': 'no-store' };
        return {
          '@context': [
            'https://www.w3.org/ns/activitystreams',
            'https://w3id.org/security/v1'
          ],
          id: expectedKeyId,
          type: matches[0].type || matches[0]['@type'] || 'RsaVerificationKey2018',
          owner: account.webId,
          controller: account.webId,
          publicKeyPem: matches[0].publicKeyPem
        };
      }
    }
  }
};
