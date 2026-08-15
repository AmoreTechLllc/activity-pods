'use strict';

process.env.SEMAPPS_AVAILABLE_LOCALES ||= 'en';
process.env.SEMAPPS_AUTH_RESERVED_USER_NAMES ||= 'admin';

const fs = require('fs');
const path = require('path');
const service = require('../services/activitypub-delivery-reconciler.service');

function methodContext(overrides = {}) {
  return {
    settings: {
      accountsDataset: 'settings',
      ...overrides.settings
    },
    ...overrides
  };
}

test('delivery reconciliation account paging is bounded and keyset-based in Fuseki', async () => {
  const call = jest.fn(async (action, params) => {
    expect(action).toBe('triplestore.query');
    expect(params.dataset).toBe('settings');
    expect(params.webId).toBe('system');
    expect(params.query).toContain('LIMIT 2');
    expect(params.query).toContain('ORDER BY STR(?accountUri)');
    expect(params.query).toContain('FILTER NOT EXISTS');
    expect(params.query).toContain('STR(?accountUri) > "urn:AuthAccount:001"');
    expect(params.query).not.toContain('OFFSET');
    return [
      {
        accountUri: { value: 'urn:AuthAccount:002' },
        webId: { value: 'https://example.test/alice' },
        username: { value: 'alice' }
      },
      {
        accountUri: { value: 'urn:AuthAccount:003' },
        webId: { value: 'https://example.test/bob' },
        username: { value: 'bob' }
      }
    ];
  });

  const result = await service.methods.listAccountPage.call(methodContext(), { call }, {
    cursor: 'urn:AuthAccount:001',
    limit: 2
  });

  expect(result).toEqual({
    accounts: [
      {
        '@id': 'urn:AuthAccount:002',
        webId: 'https://example.test/alice',
        username: 'alice'
      },
      {
        '@id': 'urn:AuthAccount:003',
        webId: 'https://example.test/bob',
        username: 'bob'
      }
    ],
    nextCursor: 'urn:AuthAccount:003'
  });
  expect(call).toHaveBeenCalledTimes(1);
});

test('delivery reconciliation account paging enforces its configured hard maximum', async () => {
  const call = jest.fn(async (_action, params) => {
    expect(params.query).toContain('LIMIT 5000');
    expect(params.query).not.toContain('OFFSET');
    return [];
  });

  const result = await service.methods.listAccountPage.call(methodContext(), { call }, {
    cursor: null,
    limit: 500000
  });

  expect(result).toEqual({ accounts: [], nextCursor: null });
});

test('delivery reconciliation rejects a quoted/tampered persisted cursor before Fuseki', async () => {
  const call = jest.fn();

  await expect(
    service.methods.listAccountPage.call(methodContext(), { call }, {
      cursor: 'urn:AuthAccount:001" ) . ?s ?p ?o . #',
      limit: 50
    })
  ).rejects.toThrow(/SPARQL injection/u);

  expect(call).not.toHaveBeenCalled();
});

test('delivery reconciler no longer delegates provider paging to SemApps auth.account.find', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../services/activitypub-delivery-reconciler.service.js'),
    'utf8'
  );

  expect(source).not.toContain("ctx.call('auth.account.find', { limit:");
  expect(source).toContain("'apdm:delivery-reconciliation:account-keyset:v2'");
  expect(source).toContain('listAccountPage(ctx, { cursor, limit: batchSize })');
});
