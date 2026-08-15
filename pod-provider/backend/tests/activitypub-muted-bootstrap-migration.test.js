'use strict';

jest.mock('@semapps/activitypub', () => ({
  ActivitiesHandlerMixin: {},
  ACTIVITY_TYPES: { UNDO: 'Undo', FOLLOW: 'Follow', ACCEPT: 'Accept' },
  ACTOR_TYPES: { PERSON: 'Person', APPLICATION: 'Application' }
}));

const schema = require('../services/activitypub-muted-collection.service');

function createService(broker, overrides = {}) {
  return {
    broker,
    settings: schema.settings,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    patchDefaultFollowProcessors: jest.fn(),
    ensureCollectionsForActor: jest.fn(),
    ...overrides
  };
}

describe('muted collection legacy bootstrap migration marker', () => {
  test('warm startup skips account enumeration after durable marker is present', async () => {
    const broker = {
      call: jest.fn(async (action, params) => {
        if (action === 'triplestore.query') {
          expect(params.query).toContain('SELECT ?completed');
          expect(params.query).toContain('LIMIT 1');
          return [{ completed: { value: 'true' } }];
        }
        if (action === 'auth.account.find') throw new Error('warm startup must not enumerate accounts');
        if (action === 'triplestore.update') throw new Error('warm startup must not rewrite marker');
        return undefined;
      }),
      getLocalService: jest.fn(() => ({ processors: [] }))
    };
    const service = createService(broker);

    await schema.started.call(service);

    expect(broker.call).not.toHaveBeenCalledWith('auth.account.find');
    expect(broker.call).not.toHaveBeenCalledWith('triplestore.update', expect.anything());
    expect(service.ensureCollectionsForActor).not.toHaveBeenCalled();
    expect(service.patchDefaultFollowProcessors).toHaveBeenCalledTimes(1);
  });

  test('first successful migration marks completion only after every actor succeeds', async () => {
    const broker = {
      call: jest.fn(async action => {
        if (action === 'triplestore.query') return [];
        if (action === 'auth.account.find') {
          return [
            { webId: 'https://example.test/users/alice' },
            { webId: 'https://example.test/users/bob' }
          ];
        }
        return undefined;
      }),
      getLocalService: jest.fn(() => ({ processors: [] }))
    };
    const service = createService(broker, {
      ensureCollectionsForActor: jest.fn(async () => undefined)
    });

    await schema.started.call(service);

    expect(service.ensureCollectionsForActor).toHaveBeenCalledTimes(2);
    expect(broker.call).toHaveBeenCalledWith(
      'triplestore.update',
      expect.objectContaining({
        dataset: 'settings',
        webId: 'system',
        query: expect.stringContaining('urn:activitypods:migration:muted-collections-v1')
      })
    );
  });

  test('partial migration failure leaves marker absent so next startup retries', async () => {
    const broker = {
      call: jest.fn(async action => {
        if (action === 'triplestore.query') return [];
        if (action === 'auth.account.find') {
          return [
            { webId: 'https://example.test/users/alice' },
            { webId: 'https://example.test/users/bob' }
          ];
        }
        return undefined;
      }),
      getLocalService: jest.fn(() => ({ processors: [] }))
    };
    const service = createService(broker, {
      ensureCollectionsForActor: jest.fn(async (_ctx, actorUri) => {
        if (actorUri.endsWith('/bob')) throw new Error('simulated bootstrap failure');
      })
    });

    await schema.started.call(service);

    expect(service.ensureCollectionsForActor).toHaveBeenCalledTimes(2);
    expect(broker.call).not.toHaveBeenCalledWith('triplestore.update', expect.anything());
    expect(service.logger.warn).toHaveBeenCalledWith(
      '[activitypub.muted] legacy collection migration remains incomplete',
      { failureCount: 1 }
    );
  });
});
