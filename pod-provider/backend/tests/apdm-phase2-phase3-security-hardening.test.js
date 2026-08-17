'use strict';

const ApdmRemoteActorEgressMiddleware = require('../middlewares/apdm-remote-actor-egress');
const {
  MAX_TARGET_RESOLUTION_CONCURRENCY,
  buildDeliveryPlanV1,
  mapWithConcurrency
} = require('../utils/activitypub-delivery-planner');
const {
  createPinnedLookup,
  fetchRemoteActivityPubActor,
  isForbiddenActivityPubAddress,
  validateRemoteActorTarget
} = require('../utils/activitypub-remote-actor-fetch');

const LOCAL = 'https://pods.example/bob';
const ACTOR = 'https://pods.example/alice';

function createLocalActivity() {
  return {
    id: 'https://pods.example/alice/activities/phase23-hardening',
    type: 'Create',
    actor: ACTOR,
    to: [LOCAL],
    cc: [],
    object: {
      id: 'https://pods.example/alice/objects/phase23-hardening',
      type: 'Note',
      attributedTo: ACTOR,
      content: 'phase 2 3 hardening'
    }
  };
}

function publicLookup(...addresses) {
  return jest.fn(async () => addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 })));
}

describe('APDM Phase 3 remote actor discovery egress', () => {
  test.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '192.0.2.10',
    '198.51.100.10',
    '203.0.113.10',
    '::1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    '2002::1'
  ])('rejects special-use address %s', address => {
    expect(isForbiddenActivityPubAddress(address)).toBe(true);
  });

  test('rejects a mixed public/private DNS answer before any HTTP request', async () => {
    const lookup = publicLookup('1.1.1.1', '10.0.0.9');
    await expect(validateRemoteActorTarget('https://remote.example/users/alice', { lookup })).rejects.toThrow(
      /forbidden address/u
    );
  });

  test.each([
    'http://remote.example/users/alice',
    'ftp://remote.example/users/alice',
    'https://user:pass@remote.example/users/alice',
    'https://remote.example/users/alice#key',
    ' https://remote.example/users/alice',
    'https://remote.example/users/alice '
  ])('rejects unsafe remote actor URI %p', async actorUri => {
    await expect(
      validateRemoteActorTarget(actorUri, { lookup: publicLookup('1.1.1.1'), allowLoopbackHttp: false })
    ).rejects.toThrow();
  });

  test('pins the validated address for scalar and all-address lookup forms', async () => {
    const target = await validateRemoteActorTarget('https://remote.example/users/alice', {
      lookup: publicLookup('1.1.1.1')
    });
    const lookup = createPinnedLookup(target);

    await expect(new Promise((resolve, reject) => {
      lookup('remote.example', {}, (error, address, family) => error ? reject(error) : resolve({ address, family }));
    })).resolves.toEqual({ address: '1.1.1.1', family: 4 });

    await expect(new Promise((resolve, reject) => {
      lookup('remote.example', { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses));
    })).resolves.toEqual([{ address: '1.1.1.1', family: 4 }]);
  });

  test('uses a no-redirect bounded pinned fetch and binds the returned actor identity', async () => {
    const fetchImpl = jest.fn(async (_url, options) => ({
      ok: true,
      status: 200,
      async json() {
        return {
          id: 'https://remote.example/users/alice',
          inbox: 'https://remote.example/users/alice/inbox'
        };
      },
      options
    }));

    await expect(fetchRemoteActivityPubActor('https://remote.example/users/alice', {
      fetchImpl,
      lookup: publicLookup('1.1.1.1')
    })).resolves.toEqual(expect.objectContaining({ id: 'https://remote.example/users/alice' }));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, options] = fetchImpl.mock.calls[0];
    expect(options.method).toBe('GET');
    expect(options.redirect).toBe('manual');
    expect(options.timeout).toBe(5000);
    expect(options.size).toBe(1024 * 1024);
    expect(options.agent).toBeDefined();
  });

  test('rejects a successful fetch whose actor identity differs from the requested recipient', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      async json() {
        return { id: 'https://remote.example/users/mallory', inbox: 'https://remote.example/inbox' };
      }
    }));
    await expect(fetchRemoteActivityPubActor('https://remote.example/users/alice', {
      fetchImpl,
      lookup: publicLookup('1.1.1.1')
    })).rejects.toThrow(/identity does not match/u);
  });

  test('production cannot enable the loopback HTTP exception through APDM_ALLOW_LOOPBACK_HTTP', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousFlag = process.env.APDM_ALLOW_LOOPBACK_HTTP;
    process.env.NODE_ENV = 'production';
    process.env.APDM_ALLOW_LOOPBACK_HTTP = 'true';
    try {
      await expect(validateRemoteActorTarget('http://127.0.0.1:8080/users/alice')).rejects.toThrow(/forbidden address|Plain HTTP/u);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousFlag === undefined) delete process.env.APDM_ALLOW_LOOPBACK_HTTP;
      else process.env.APDM_ALLOW_LOOPBACK_HTTP = previousFlag;
    }
  });
});

describe('APDM Phase 2 external actor action boundary', () => {
  test('disabled/native mode delegates unchanged', async () => {
    const next = jest.fn(async () => ({ native: true }));
    const fetchRemoteActor = jest.fn();
    const middleware = ApdmRemoteActorEgressMiddleware({ enabled: false, fetchRemoteActor });
    const wrapped = middleware.localAction(next, { name: 'activitypub.actor.get' });
    await expect(wrapped({ params: { actorUri: 'https://remote.example/users/alice' } })).resolves.toEqual({ native: true });
    expect(fetchRemoteActor).not.toHaveBeenCalled();
  });

  test('external mode preserves the SemApps local dataset branch', async () => {
    const next = jest.fn(async () => ({ local: true }));
    const fetchRemoteActor = jest.fn();
    const middleware = ApdmRemoteActorEgressMiddleware({ enabled: true, fetchRemoteActor });
    const wrapped = middleware.localAction(next, { name: 'activitypub.actor.get' });
    const ctx = {
      params: { actorUri: LOCAL },
      meta: { dataset: 'bob' },
      call: jest.fn(async action => {
        if (action === 'ldp.remote.isRemote') return false;
        throw new Error(`Unexpected call ${action}`);
      })
    };

    await expect(wrapped(ctx)).resolves.toEqual({ local: true });
    expect(next).toHaveBeenCalledWith(ctx);
    expect(fetchRemoteActor).not.toHaveBeenCalled();
  });

  test('external mode replaces only the SemApps remote actor fetch branch', async () => {
    const next = jest.fn();
    const fetchRemoteActor = jest.fn(async actorUri => ({ id: actorUri }));
    const middleware = ApdmRemoteActorEgressMiddleware({ enabled: true, fetchRemoteActor });
    const wrapped = middleware.localAction(next, { name: 'activitypub.actor.get' });
    const ctx = { params: { actorUri: 'https://remote.example/users/alice' }, meta: {} };

    await expect(wrapped(ctx)).resolves.toEqual({ id: 'https://remote.example/users/alice' });
    expect(fetchRemoteActor).toHaveBeenCalledWith('https://remote.example/users/alice');
    expect(next).not.toHaveBeenCalled();
  });
});

describe('APDM Phase 3 planner authority hardening', () => {
  test('rejects a pre-resolved account hint whose identity does not match the local recipient', async () => {
    const ctx = { call: jest.fn() };
    await expect(buildDeliveryPlanV1(ctx, {
      activity: createLocalActivity(),
      localRecipientUris: [LOCAL],
      localRecipientAccounts: new Map([[LOCAL, { webId: 'https://pods.example/mallory', username: 'bob' }]])
    })).rejects.toThrow(/does not match/u);
    expect(ctx.call).not.toHaveBeenCalled();
  });

  test('rejects an unbound pre-resolved account hint rather than trusting its dataset', async () => {
    const ctx = { call: jest.fn() };
    await expect(buildDeliveryPlanV1(ctx, {
      activity: createLocalActivity(),
      localRecipientUris: [LOCAL],
      localRecipientAccounts: new Map([[LOCAL, { username: 'bob' }]])
    })).rejects.toThrow(/does not match/u);
    expect(ctx.call).not.toHaveBeenCalled();
  });

  test('caps an arbitrarily large resolution budget while preserving deterministic ordering', async () => {
    const items = Array.from({ length: 100 }, (_, index) => index);
    let active = 0;
    let maxActive = 0;
    const result = await mapWithConcurrency(items, Number.POSITIVE_INFINITY, async item => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setImmediate(resolve));
      active -= 1;
      return item * 2;
    });

    expect(maxActive).toBeLessThanOrEqual(MAX_TARGET_RESOLUTION_CONCURRENCY);
    expect(maxActive).toBe(1);
    expect(result).toEqual(items.map(item => item * 2));
  });

  test('caps huge finite resolution budgets at the explicit Phase 3 ceiling', async () => {
    const items = Array.from({ length: 100 }, (_, index) => index);
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency(items, Number.MAX_SAFE_INTEGER, async item => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setImmediate(resolve));
      active -= 1;
      return item;
    });
    expect(maxActive).toBe(MAX_TARGET_RESOLUTION_CONCURRENCY);
  });
});
