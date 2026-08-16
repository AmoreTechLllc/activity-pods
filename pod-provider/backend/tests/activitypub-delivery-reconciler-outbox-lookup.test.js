'use strict';

process.env.SEMAPPS_AVAILABLE_LOCALES ||= 'en';
process.env.SEMAPPS_AUTH_RESERVED_USER_NAMES ||= 'admin';

const service = require('../services/activitypub-delivery-reconciler.service');

const ACTOR = 'https://pods.example/alice';
const DATASET = 'alice';
const OUTBOX = `${ACTOR}/outbox`;

function rows(...uris) {
  return uris.map(uri => ({ outboxUri: { value: uri } }));
}

test('selective outbox lookup queries only the authoritative actor predicate in the account dataset', async () => {
  const call = jest.fn(async (action, params) => {
    expect(action).toBe('triplestore.query');
    expect(params.dataset).toBe(DATASET);
    expect(params.webId).toBe('system');
    expect(params.accept).toBe('application/sparql-results+json');
    expect(params.query).toContain('PREFIX as: <https://www.w3.org/ns/activitystreams#>');
    expect(params.query).toContain(`<${ACTOR}> as:outbox ?outboxUri`);
    expect(params.query).toMatch(/SELECT DISTINCT \?outboxUri/u);
    expect(params.query).toMatch(/LIMIT 2/u);
    return rows(OUTBOX);
  });

  await expect(service.methods.resolveLocalOutboxUri({ call }, ACTOR, DATASET)).resolves.toBe(OUTBOX);
  expect(call).toHaveBeenCalledTimes(1);
});

test('selective outbox lookup fails closed for missing or ambiguous persisted outbox triples', async () => {
  await expect(
    service.methods.resolveLocalOutboxUri(
      { call: jest.fn(async () => []) },
      ACTOR,
      DATASET
    )
  ).rejects.toThrow(/Unable to resolve safe local outbox/u);

  await expect(
    service.methods.resolveLocalOutboxUri(
      { call: jest.fn(async () => rows(OUTBOX, `${ACTOR}/other-outbox`)) },
      ACTOR,
      DATASET
    )
  ).rejects.toThrow(/unambiguous local outbox/u);
});

test.each([
  'javascript:alert(1)',
  'ftp://pods.example/alice/outbox',
  'https://user:password@pods.example/alice/outbox',
  'https://pods.example/alice/outbox#fragment',
  ' https://pods.example/alice/outbox'
])('selective outbox lookup rejects unsafe persisted endpoint %s', async unsafeOutbox => {
  await expect(
    service.methods.resolveLocalOutboxUri(
      { call: jest.fn(async () => rows(unsafeOutbox)) },
      ACTOR,
      DATASET
    )
  ).rejects.toThrow(/Unable to resolve safe local outbox/u);
});

test('selective outbox lookup rejects SPARQL injection in actor URI before reaching Fuseki', async () => {
  const call = jest.fn();
  const injectedActor = 'https://pods.example/alice> ?s ?p ?o . #';

  await expect(
    service.methods.resolveLocalOutboxUri({ call }, injectedActor, DATASET)
  ).rejects.toThrow(/SPARQL injection/u);

  expect(call).not.toHaveBeenCalled();
});

test.each([
  [null, DATASET, /local actor URI/u],
  ['', DATASET, /local actor URI/u],
  [ACTOR, null, /local dataset/u],
  [ACTOR, '', /local dataset/u]
])('selective outbox lookup rejects invalid authority inputs', async (actorUri, dataset, pattern) => {
  const call = jest.fn();

  await expect(
    service.methods.resolveLocalOutboxUri({ call }, actorUri, dataset)
  ).rejects.toThrow(pattern);

  expect(call).not.toHaveBeenCalled();
});

test('reconcileAccount fails the account scan without falling back to actor materialization when outbox authority is ambiguous', async () => {
  const context = {
    settings: { lookbackMs: 900000, maxActivitiesPerAccount: 50 },
    logger: { warn: jest.fn() },
    resolveLocalOutboxUri: service.methods.resolveLocalOutboxUri,
    listOutboxActivityPage: jest.fn()
  };
  const ctx = {
    call: jest.fn(async (action) => {
      if (action === 'triplestore.query') return rows(OUTBOX, `${ACTOR}/other-outbox`);
      if (action === 'activitypub.actor.getCollectionUri') {
        throw new Error('heavy actor materialization fallback is forbidden');
      }
      throw new Error(`Unexpected call ${action}`);
    })
  };

  const result = await service.methods.reconcileAccount.call(
    context,
    ctx,
    { webId: ACTOR, username: DATASET }
  );

  expect(result).toEqual({ activitiesScanned: 0, handoffsRequeued: 0, failures: 1 });
  expect(context.listOutboxActivityPage).not.toHaveBeenCalled();
  expect(ctx.call.mock.calls.some(([action]) => action === 'activitypub.actor.getCollectionUri')).toBe(false);
  expect(context.logger.warn).toHaveBeenCalledWith(
    'Failed to scan ActivityPub outbox during delivery reconciliation',
    expect.objectContaining({ actorUri: ACTOR, dataset: DATASET })
  );
});
