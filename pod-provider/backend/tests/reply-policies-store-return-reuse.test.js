'use strict';

jest.mock('../config/config', () => ({ BASE_URL: 'https://local.example' }));

const { MIME_TYPES } = require('@semapps/mime-types');
const schema = require('../services/reply-policies.service');

function createService() {
  return {
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    ...schema.methods
  };
}

describe('reply policy remote-store return reuse', () => {
  test('returns the freshly stored remote resource without rereading it', async () => {
    const service = createService();
    const resourceUri = 'https://remote.example/objects/1';
    const webId = 'https://local.example/alice';
    const fresh = { id: resourceUri, type: 'Note', content: 'fresh' };
    const ctx = {
      call: jest.fn(async action => {
        if (action === 'ldp.remote.store') return fresh;
        throw new Error(`unexpected action ${action}`);
      })
    };

    await expect(service.loadObject(ctx, resourceUri, webId)).resolves.toBe(fresh);
    expect(ctx.call).toHaveBeenCalledTimes(1);
    expect(ctx.call).toHaveBeenCalledWith('ldp.remote.store', { resourceUri, webId });
  });

  test('falls back to ldp.resource.get when remote.store rejects a local resource', async () => {
    const service = createService();
    const resourceUri = 'https://local.example/alice/notes/1';
    const webId = 'https://local.example/alice';
    const local = { id: resourceUri, type: 'Note' };
    const calls = [];
    const ctx = {
      call: jest.fn(async (action, params) => {
        calls.push({ action, params });
        if (action === 'ldp.remote.store') throw new Error('resource is not remote');
        if (action === 'ldp.resource.get') return local;
        throw new Error(`unexpected action ${action}`);
      })
    };

    await expect(service.loadObject(ctx, resourceUri, webId)).resolves.toBe(local);
    expect(calls.map(call => call.action)).toEqual(['ldp.remote.store', 'ldp.resource.get']);
    expect(calls[1].params).toEqual({ resourceUri, accept: MIME_TYPES.JSON, webId });
  });

  test('preserves cached/local fallback when a remote refresh fails', async () => {
    const service = createService();
    const resourceUri = 'https://remote.example/objects/2';
    const cached = { id: resourceUri, type: 'Note', content: 'cached fallback' };
    const calls = [];
    const ctx = {
      call: jest.fn(async action => {
        calls.push(action);
        if (action === 'ldp.remote.store') throw new Error('network unavailable');
        if (action === 'ldp.resource.get') return cached;
        throw new Error(`unexpected action ${action}`);
      })
    };

    await expect(service.loadObject(ctx, resourceUri, 'system')).resolves.toBe(cached);
    expect(calls).toEqual(['ldp.remote.store', 'ldp.resource.get']);
  });

  test('preserves actor fallback if both store and resource reads fail', async () => {
    const service = createService();
    const resourceUri = 'https://remote.example/actors/alice';
    const actor = { id: resourceUri, type: 'Person' };
    const calls = [];
    const ctx = {
      call: jest.fn(async action => {
        calls.push(action);
        if (action === 'ldp.remote.store' || action === 'ldp.resource.get') throw new Error('not available');
        if (action === 'activitypub.actor.get') return actor;
        throw new Error(`unexpected action ${action}`);
      })
    };

    await expect(service.loadObject(ctx, resourceUri, 'system')).resolves.toBe(actor);
    expect(calls).toEqual(['ldp.remote.store', 'ldp.resource.get', 'activitypub.actor.get']);
  });
});
