'use strict';

process.env.SEMAPPS_AVAILABLE_LOCALES ||= 'en';
process.env.SEMAPPS_AUTH_RESERVED_USER_NAMES ||= 'admin';

const service = require('../services/activitypub-delivery-reconciler.service');

function methodContext() {
  return {
    settings: { maxActivitiesPerAccount: 50 },
    logger: { warn: jest.fn() }
  };
}

test('outbox reconciliation pages with a composite keyset and no OFFSET', async () => {
  const published = '2026-08-15T22:00:00.000Z';
  const call = jest.fn(async (action, params) => {
    expect(action).toBe('triplestore.query');
    expect(params.dataset).toBe('alice');
    expect(params.webId).toBe('system');
    expect(params.query).toContain('LIMIT 2');
    expect(params.query).not.toContain('OFFSET');
    expect(params.query).toContain('ORDER BY DESC(STR(?published)) ASC(STR(?activityUri))');
    expect(params.query).toContain(`STR(?published) < "${published}"`);
    expect(params.query).toContain(`STR(?published) = "${published}"`);
    expect(params.query).toContain('STR(?activityUri) > "https://pods.example/alice/activities/002"');
    return [
      {
        activityUri: { value: 'https://pods.example/alice/activities/003' },
        published: { value: published }
      },
      {
        activityUri: { value: 'https://pods.example/alice/activities/004' },
        published: { value: '2026-08-15T21:59:59.000Z' }
      }
    ];
  });

  const result = await service.methods.listOutboxActivityPage.call(
    methodContext(),
    { call },
    {
      outboxUri: 'https://pods.example/alice/outbox',
      dataset: 'alice',
      cursor: { published, activityUri: 'https://pods.example/alice/activities/002' },
      limit: 2
    }
  );

  expect(result.nextCursor).toEqual({
    published: '2026-08-15T21:59:59.000Z',
    activityUri: 'https://pods.example/alice/activities/004'
  });
  expect(result.rows).toHaveLength(2);
});

test('outbox keyset tie-breaks equal timestamps by activity URI', async () => {
  const published = '2026-08-15T22:00:00.000Z';
  const call = jest.fn(async (_action, params) => {
    expect(params.query).toContain(`(STR(?published) = "${published}" && STR(?activityUri) > "https://pods.example/alice/activities/a")`);
    return [
      {
        activityUri: { value: 'https://pods.example/alice/activities/b' },
        published: { value: published }
      }
    ];
  });

  const result = await service.methods.listOutboxActivityPage.call(
    methodContext(),
    { call },
    {
      outboxUri: 'https://pods.example/alice/outbox',
      dataset: 'alice',
      cursor: { published, activityUri: 'https://pods.example/alice/activities/a' },
      limit: 50
    }
  );

  expect(result.nextCursor).toEqual({
    published,
    activityUri: 'https://pods.example/alice/activities/b'
  });
});

test('outbox paging enforces the hard page maximum', async () => {
  const call = jest.fn(async (_action, params) => {
    expect(params.query).toContain('LIMIT 1000');
    expect(params.query).not.toContain('OFFSET');
    return [];
  });

  await service.methods.listOutboxActivityPage.call(
    methodContext(),
    { call },
    {
      outboxUri: 'https://pods.example/alice/outbox',
      dataset: 'alice',
      cursor: null,
      limit: 100000
    }
  );

  expect(call).toHaveBeenCalledTimes(1);
});

test.each([
  [{ published: '2026-08-15T22:00:00.000Z" . ?s ?p ?o . #', activityUri: 'https://pods.example/alice/activities/a' }],
  [{ published: '2026-08-15T22:00:00.000Z', activityUri: 'https://pods.example/alice/activities/a" . ?s ?p ?o . #' }]
])('outbox keyset rejects tampered cursor values before Fuseki', async cursor => {
  const call = jest.fn();

  await expect(
    service.methods.listOutboxActivityPage.call(
      methodContext(),
      { call },
      {
        outboxUri: 'https://pods.example/alice/outbox',
        dataset: 'alice',
        cursor,
        limit: 50
      }
    )
  ).rejects.toThrow(/SPARQL injection/u);

  expect(call).not.toHaveBeenCalled();
});

test('reconcileAccount stops rather than looping when an outbox cursor cannot advance', async () => {
  const published = new Date().toISOString();
  const cursor = { published, activityUri: 'https://pods.example/alice/activities/a' };
  const context = {
    settings: { lookbackMs: 900000, maxActivitiesPerAccount: 1 },
    logger: { warn: jest.fn() },
    listOutboxActivityPage: jest
      .fn()
      .mockResolvedValueOnce({
        rows: [{ activityUri: { value: cursor.activityUri }, published: { value: published } }],
        nextCursor: cursor
      })
      .mockResolvedValueOnce({
        rows: [{ activityUri: { value: cursor.activityUri }, published: { value: published } }],
        nextCursor: cursor
      }),
    reconcileActivity: jest.fn(async () => null)
  };
  const ctx = {
    async call(action, params) {
      if (action === 'activitypub.actor.getCollectionUri') return 'https://pods.example/alice/outbox';
      if (action === 'activitypub.activity.get') {
        return { id: params.resourceUri, published, type: 'Create', actor: 'https://pods.example/alice' };
      }
      throw new Error(`Unexpected call ${action}`);
    }
  };

  const result = await service.methods.reconcileAccount.call(
    context,
    ctx,
    { webId: 'https://pods.example/alice', username: 'alice' }
  );

  expect(context.listOutboxActivityPage).toHaveBeenCalledTimes(2);
  expect(result).toEqual({ activitiesScanned: 2, handoffsRequeued: 0, failures: 1 });
  expect(context.logger.warn).toHaveBeenCalledWith(
    'ActivityPub delivery reconciliation outbox cursor failed to advance',
    expect.objectContaining({ actorUri: 'https://pods.example/alice', dataset: 'alice' })
  );
});
