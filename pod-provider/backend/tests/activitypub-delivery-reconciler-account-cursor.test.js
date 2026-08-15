'use strict';

process.env.SEMAPPS_AVAILABLE_LOCALES ||= 'en';
process.env.SEMAPPS_AUTH_RESERVED_USER_NAMES ||= 'admin';

const service = require('../services/activitypub-delivery-reconciler.service');

test('account cursor persists keyset progress and deletes state at wraparound', async () => {
  const redis = {
    get: jest.fn(async () => 'urn:AuthAccount:010'),
    set: jest.fn(async () => 'OK'),
    del: jest.fn(async () => 1)
  };
  const context = {
    reconciliationRedis: redis,
    settings: { accountCursorKey: 'cursor-key' }
  };

  await expect(service.methods.getAccountCursor.call(context)).resolves.toBe('urn:AuthAccount:010');
  await service.methods.setAccountCursor.call(context, 'urn:AuthAccount:011');
  expect(redis.set).toHaveBeenCalledWith('cursor-key', 'urn:AuthAccount:011');

  await service.methods.setAccountCursor.call(context, null);
  expect(redis.del).toHaveBeenCalledWith('cursor-key');
});

test('empty account cursor state starts at the first keyset page', async () => {
  const context = {
    reconciliationRedis: { get: jest.fn(async () => null) },
    settings: { accountCursorKey: 'cursor-key' }
  };

  await expect(service.methods.getAccountCursor.call(context)).resolves.toBeNull();
});
