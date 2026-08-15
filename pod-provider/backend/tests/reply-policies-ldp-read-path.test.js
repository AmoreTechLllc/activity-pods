'use strict';

process.env.SEMAPPS_AVAILABLE_LOCALES = process.env.SEMAPPS_AVAILABLE_LOCALES || 'en';
process.env.SEMAPPS_HOME_URL = process.env.SEMAPPS_HOME_URL || 'https://local.example';

const fs = require('fs');
const path = require('path');
const { MIME_TYPES } = require('@semapps/mime-types');
const schema = require('../services/reply-policies.service');

function createService() {
  return {
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    ...schema.methods
  };
}

describe('reply policy LDP read scalability', () => {
  test('loadObject delegates locality/cache/network selection to ldp.resource.get without remote.store preflight', async () => {
    const service = createService();
    const resourceUri = 'https://remote.example/objects/1';
    const resource = { id: resourceUri, type: 'Note' };
    const calls = [];
    const ctx = {
      call: jest.fn(async (action, params) => {
        calls.push({ action, params });
        if (action === 'ldp.resource.get') return resource;
        throw new Error(`unexpected action ${action}`);
      })
    };

    await expect(service.loadObject(ctx, resourceUri, 'https://local.example/alice')).resolves.toBe(resource);
    expect(calls).toEqual([
      {
        action: 'ldp.resource.get',
        params: {
          resourceUri,
          accept: MIME_TYPES.JSON,
          webId: 'https://local.example/alice'
        }
      }
    ]);
  });

  test('system-scoped inbound reads still use one LDP get and preserve actor fallback', async () => {
    const service = createService();
    const resourceUri = 'https://remote.example/objects/missing';
    const actor = { id: resourceUri, type: 'Person' };
    const calls = [];
    const ctx = {
      call: jest.fn(async (action, params) => {
        calls.push({ action, params });
        if (action === 'ldp.resource.get') {
          const error = new Error('not found');
          error.code = 404;
          throw error;
        }
        if (action === 'activitypub.actor.get') return actor;
        throw new Error(`unexpected action ${action}`);
      })
    };

    await expect(service.loadObject(ctx, resourceUri, 'system')).resolves.toBe(actor);
    expect(calls.map(call => call.action)).toEqual(['ldp.resource.get', 'activitypub.actor.get']);
    expect(calls[0].params.webId).toBe('system');
  });

  test('local object reads no longer attempt the remote write path before local LDP resolution', async () => {
    const service = createService();
    const resourceUri = 'https://local.example/alice/notes/1';
    const ctx = {
      call: jest.fn(async action => {
        if (action === 'ldp.resource.get') return { id: resourceUri, type: 'Note' };
        throw new Error(`unexpected action ${action}`);
      })
    };

    const result = await service.loadObject(ctx, resourceUri, 'https://local.example/alice');

    expect(result.id).toBe(resourceUri);
    expect(ctx.call).toHaveBeenCalledTimes(1);
    expect(ctx.call).toHaveBeenCalledWith('ldp.resource.get', expect.objectContaining({ resourceUri }));
  });

  test('service source contains no ldp.remote.store call expression in the reply-policy read path', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/reply-policies.service.js'), 'utf8');
    const start = source.indexOf('async loadObject(');
    const end = source.indexOf('async evaluateLocalAuthorityPermission(', start);
    const loadObjectSource = source.slice(start, end);

    expect(loadObjectSource).toContain("ctx.call('ldp.resource.get'");
    expect(loadObjectSource).not.toContain("ctx.call('ldp.remote.store'");
  });
});
