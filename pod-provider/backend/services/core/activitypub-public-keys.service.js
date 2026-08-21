'use strict';

const crypto = require('crypto');
const { Errors: E } = require('moleculer-web');
const { MIME_TYPES } = require('@semapps/mime-types');
const { sanitizeSparqlQuery } = require('@semapps/triplestore');
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

function bindingValue(row, name) {
  const value = row?.[name]?.value;
  return typeof value === 'string' ? value : null;
}

module.exports = {
  name: 'activitypub-public-keys',

  dependencies: ['api', 'auth.account', 'activitypub.actor', 'triplestore'],

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
        if (matches.length !== 1) throw new E.NotFoundError();

        const keyIri = sanitizeSparqlQuery`<${expectedKeyId}>`;
        const rows = await ctx.call('triplestore.query', {
          query: `
            PREFIX sec: <https://w3id.org/security#>
            SELECT DISTINCT ?owner ?controller ?publicKeyPem
            WHERE {
              ${keyIri} sec:owner ?owner ;
                        sec:controller ?controller ;
                        sec:publicKeyPem ?publicKeyPem .
            }
            LIMIT 2
          `,
          accept: MIME_TYPES.SPARQL_JSON,
          dataset: account.username,
          webId: 'system'
        });
        if (!Array.isArray(rows) || rows.length !== 1) throw new E.NotFoundError();
        const owner = bindingValue(rows[0], 'owner');
        const controller = bindingValue(rows[0], 'controller');
        const publicKeyPem = bindingValue(rows[0], 'publicKeyPem');
        if (!publicKeyPem || owner !== account.webId || controller !== account.webId) throw new E.NotFoundError();

        let parsedKey;
        try {
          parsedKey = crypto.createPublicKey(publicKeyPem);
        } catch {
          throw new E.NotFoundError();
        }
        if (parsedKey.asymmetricKeyType !== 'rsa') throw new E.NotFoundError();
        ctx.meta.$responseType = 'application/activity+json';
        ctx.meta.$responseHeaders = { 'Cache-Control': 'no-store' };
        return {
          '@context': [
            'https://www.w3.org/ns/activitystreams',
            'https://w3id.org/security/v1'
          ],
          id: expectedKeyId,
          type: 'RsaVerificationKey2018',
          owner: account.webId,
          controller: account.webId,
          publicKeyPem
        };
      }
    }
  }
};
