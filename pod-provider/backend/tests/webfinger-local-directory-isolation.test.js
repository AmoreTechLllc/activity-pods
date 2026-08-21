'use strict';

jest.mock('../config/config', () => ({ BASE_URL: 'https://activitypods' }));

const service = require('../services/core/webfinger');

describe('local WebFinger directory isolation', () => {
  function instance(broker = { call: jest.fn() }) {
    const value = { settings: { domainName: 'activitypods' }, broker };
    service.created.call(value);
    return value;
  }

  test('serves a newly registered local actor from the event-backed directory without a datastore round trip', async () => {
    const broker = { call: jest.fn() };
    const self = instance(broker);
    service.events['auth.registered'].call(self, {
      params: { accountData: { username: 'alice' }, webId: 'https://activitypods/alice' }
    });

    await expect(service.actions.get.call(self, {
      params: { resource: 'acct:alice@activitypods' }, meta: {}
    })).resolves.toMatchObject({ aliases: ['https://activitypods/alice'] });
    expect(broker.call).not.toHaveBeenCalled();
  });

  test('resolves an existing local account through a context-independent broker call', async () => {
    const broker = {
      call: jest.fn().mockResolvedValue({ webId: 'https://activitypods/alice' })
    };
    const ctx = {
      params: { resource: 'acct:alice@activitypods' },
      meta: { webId: 'https://remote.example/users/bob' },
      call: jest.fn(() => { throw new Error('request context must not be propagated'); })
    };

    await expect(service.actions.get.call(instance(broker), ctx)).resolves.toEqual({
      subject: 'acct:alice@activitypods',
      aliases: ['https://activitypods/alice'],
      links: [{ rel: 'self', type: 'application/activity+json', href: 'https://activitypods/alice' }]
    });
    expect(broker.call).toHaveBeenCalledWith('auth.account.findByUsername', { username: 'alice' }, { timeout: 2000 });
    expect(ctx.call).not.toHaveBeenCalled();
  });

  test.each([
    'acct:alice@remote.example',
    'acct:ali@ce@activitypods',
    'acct:../alice@activitypods',
    'https://activitypods/alice'
  ])('fails closed for non-local or malformed resource %s', async resource => {
    const broker = { call: jest.fn() };
    const ctx = { params: { resource }, meta: {} };

    await expect(service.actions.get.call(instance(broker), ctx)).resolves.toBeUndefined();
    expect(ctx.meta.$statusCode).toBe(404);
    expect(broker.call).not.toHaveBeenCalled();
  });

  test('returns 404 for a well-formed local account that does not exist', async () => {
    const broker = { call: jest.fn().mockResolvedValue(null) };
    const ctx = { params: { resource: 'acct:missing@activitypods' }, meta: {} };

    await expect(service.actions.get.call(instance(broker), ctx)).resolves.toBeUndefined();
    expect(ctx.meta.$statusCode).toBe(404);
  });
});
