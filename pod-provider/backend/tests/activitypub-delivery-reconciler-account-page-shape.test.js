'use strict';

process.env.SEMAPPS_AVAILABLE_LOCALES ||= 'en';
process.env.SEMAPPS_AUTH_RESERVED_USER_NAMES ||= 'admin';

const service = require('../services/activitypub-delivery-reconciler.service');

test('account page skips deleted accounts in SPARQL rather than materializing then filtering', async () => {
  const call = jest.fn(async (_action, params) => {
    expect(params.query).toMatch(/FILTER NOT EXISTS\s*\{\s*\?accountUri semapps:deletedAt \?deletedAt/u);
    expect(params.query).toMatch(/SELECT \?accountUri \?webId \?username/u);
    expect(params.query).not.toMatch(/SELECT \*/u);
    return [];
  });

  await service.methods.listAccountPage.call(
    { settings: { accountsDataset: 'settings' } },
    { call },
    { cursor: null, limit: 50 }
  );

  expect(call).toHaveBeenCalledTimes(1);
});
