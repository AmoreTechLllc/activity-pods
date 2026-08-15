jest.mock('@semapps/activitypub', () => ({
  ActivitiesHandlerMixin: {},
  ACTIVITY_TYPES: {
    BLOCK: 'Block',
    UNDO: 'Undo',
    FOLLOW: 'Follow',
    ACCEPT: 'Accept'
  },
  ACTOR_TYPES: {
    PERSON: 'Person',
    APPLICATION: 'Application'
  }
}));

const blockedService = require('../services/activitypub-blocked-collection.service');
const mutedService = require('../services/activitypub-muted-collection.service');

const ACTOR_URI = 'https://pod.example/users/alice';
const DATASET = 'alice';

function makeContext(overrides = {}) {
  const calls = [];
  const ctx = {
    meta: {},
    async call(action, params, options) {
      calls.push({ action, params, options });
      if (action === 'auth.account.findByWebId') {
        return { webId: ACTOR_URI, username: DATASET };
      }
      if (action === 'activitypub.actor.get') {
        return {
          id: ACTOR_URI,
          blocked: `${ACTOR_URI}/blocked`,
          blocks: `${ACTOR_URI}/blocks`,
          muted: `${ACTOR_URI}/muted`
        };
      }
      if (action === 'triplestore.query') return [];
      if (action === 'ldp.resource.patch') return { resourceUri: params.resourceUri };
      return undefined;
    },
    ...overrides
  };
  return { ctx, calls };
}

function bindMethods(serviceDefinition) {
  const methods = { ...serviceDefinition.methods };
  for (const [name, fn] of Object.entries(methods)) {
    if (typeof fn === 'function') methods[name] = fn.bind(methods);
  }
  return methods;
}

describe('ActivityPub collection service dataset context', () => {
  test.each([
    ['blocked', blockedService, 'resolveBlockedCollectionUri'],
    ['muted', mutedService, 'resolveMutedCollectionUri']
  ])('%s actor resolution supplies the actor WebID', async (_name, service, methodName) => {
    const { ctx, calls } = makeContext();

    await service.methods[methodName].call(service.methods, ctx, ACTOR_URI);

    expect(calls).toContainEqual(
      expect.objectContaining({
        action: 'activitypub.actor.get',
        params: { actorUri: ACTOR_URI, webId: ACTOR_URI }
      })
    );
  });

  test.each([
    ['blocked', blockedService, 'getBlockedCollectionSharingStateByCollectionUri', `${ACTOR_URI}/blocked`],
    ['muted', mutedService, 'getMutedCollectionSharingStateByCollectionUri', `${ACTOR_URI}/muted`]
  ])('%s sharing-state query resolves and supplies the owning dataset', async (_name, service, methodName, collectionUri) => {
    const { ctx, calls } = makeContext();
    const methods = bindMethods(service);

    await methods[methodName](ctx, collectionUri);

    expect(calls).toContainEqual(
      expect.objectContaining({
        action: 'auth.account.findByWebId',
        params: { webId: ACTOR_URI }
      })
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        action: 'triplestore.query',
        params: expect.objectContaining({ webId: 'system', dataset: DATASET })
      })
    );
  });

  test.each([
    ['blocked', blockedService],
    ['muted', mutedService]
  ])('%s metadata patch carries least-privilege WebID and dataset meta', async (_name, service) => {
    const { ctx, calls } = makeContext();
    const methods = bindMethods(service);

    await methods.ensureCollectionMetadata(
      ctx,
      `${ACTOR_URI}/${_name}`,
      ACTOR_URI,
      'https://example.test/inverse',
      DATASET
    );

    expect(calls).toContainEqual(
      expect.objectContaining({
        action: 'ldp.resource.patch',
        params: expect.objectContaining({
          resourceUri: `${ACTOR_URI}/${_name}`,
          webId: ACTOR_URI
        }),
        options: expect.objectContaining({
          meta: expect.objectContaining({ dataset: DATASET, skipObjectsWatcher: true })
        })
      })
    );
  });

  test.each([
    ['blocked', blockedService, 'getBlockedCollectionSharingStateByCollectionUri', `${ACTOR_URI}/blocked`],
    ['muted', mutedService, 'getMutedCollectionSharingStateByCollectionUri', `${ACTOR_URI}/muted`]
  ])('%s sharing-state fails closed when the owner dataset cannot be resolved', async (_name, service, methodName, collectionUri) => {
    const { ctx } = makeContext({
      async call(action) {
        if (action === 'auth.account.findByWebId') return null;
        throw new Error(`unexpected action after missing dataset: ${action}`);
      }
    });
    const methods = bindMethods(service);

    await expect(methods[methodName](ctx, collectionUri)).rejects.toThrow(/dataset/i);
  });
});
