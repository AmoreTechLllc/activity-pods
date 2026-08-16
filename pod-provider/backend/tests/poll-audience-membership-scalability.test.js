'use strict';

const { getDatasetFromUri } = require('@semapps/ldp');
const schema = require('../services/polls-manager.service');

function createService(overrides = {}) {
  return {
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    pollStateById: new Map(),
    ...schema.methods,
    ...overrides
  };
}

function pollWithAudience(audience) {
  return {
    pollId: 'https://example.test/users/alice/polls/1',
    audience
  };
}

describe('poll audience collection membership scalability', () => {
  test('direct actor audience match performs no triplestore work', async () => {
    const actorUri = 'https://remote.example/users/bob';
    const service = createService();
    const ctx = { call: jest.fn() };

    const allowed = await service.isActorAllowedByAudience(ctx, pollWithAudience([actorUri]), actorUri);

    expect(allowed).toBe(true);
    expect(ctx.call).not.toHaveBeenCalled();
  });

  test('same-dataset collections use one authoritative batched ASK with SemApps membership semantics', async () => {
    const actorUri = 'https://remote.example/users/bob';
    const first = 'https://example.test/users/alice/followers';
    const second = 'https://example.test/users/alice/collections/friends';
    const expectedDataset = getDatasetFromUri(first);
    expect(getDatasetFromUri(second)).toBe(expectedDataset);

    const calls = [];
    const service = createService();
    const ctx = {
      call: jest.fn(async (action, params) => {
        calls.push({ action, params });
        return true;
      })
    };

    const allowed = await service.isActorAllowedByAudience(ctx, pollWithAudience([first, second]), actorUri);

    expect(allowed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe('triplestore.query');
    expect(calls[0].params.dataset).toBe(expectedDataset);
    expect(calls[0].params.webId).toBe('system');
    expect(calls[0].params.query).toContain('ASK WHERE');
    expect(calls[0].params.query).toContain('VALUES ?collectionUri');
    expect(calls[0].params.query).toContain(`<${first}>`);
    expect(calls[0].params.query).toContain(`<${second}>`);
    expect(calls[0].params.query).toContain('?collectionUri a as:Collection');
    expect(calls[0].params.query).toContain(`as:items <${actorUri}>`);
    expect(calls.some(call => call.action === 'activitypub.collection.includes')).toBe(false);
  });

  test('collections from different SemApps datasets are queried separately', async () => {
    const actorUri = 'https://remote.example/users/bob';
    const first = 'https://example.test/users/alice/followers';
    const second = 'https://example.test/groups/team/followers';
    const firstDataset = getDatasetFromUri(first);
    const secondDataset = getDatasetFromUri(second);
    expect(secondDataset).not.toBe(firstDataset);

    const calls = [];
    const service = createService();
    const ctx = {
      call: jest.fn(async (action, params) => {
        calls.push({ action, params });
        return false;
      })
    };

    const allowed = await service.isActorAllowedByAudience(ctx, pollWithAudience([first, second]), actorUri);

    expect(allowed).toBe(false);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map(call => call.params.dataset))).toEqual(new Set([firstDataset, secondDataset]));
    expect(calls.every(call => call.action === 'triplestore.query')).toBe(true);
  });

  test('healthy path bounds large same-dataset audiences by item count', async () => {
    const actorUri = 'https://remote.example/users/bob';
    const audience = Array.from(
      { length: 1001 },
      (_, index) => `https://example.test/users/alice/collections/audience-${index}`
    );
    const calls = [];
    const service = createService();
    const ctx = {
      call: jest.fn(async (action, params) => {
        calls.push({ action, params });
        return false;
      })
    };

    const allowed = await service.isActorAllowedByAudience(ctx, pollWithAudience(audience), actorUri);

    expect(allowed).toBe(false);
    expect(calls).toHaveLength(3);
    const valueCounts = calls.map(call => (call.params.query.match(/<https:\/\/example\.test\/users\/alice\/collections\/audience-/g) || []).length);
    expect(valueCounts).toEqual([500, 500, 1]);
    expect(calls.every(call => call.params.query.length < 66_500)).toBe(true);
  });

  test('VALUES payload bound splits unusually long valid collection IRIs before count limit', async () => {
    const actorUri = 'https://remote.example/users/bob';
    const audience = Array.from(
      { length: 40 },
      (_, index) => `https://example.test/users/alice/collections/${String(index).padStart(2, '0')}-${'x'.repeat(3000)}`
    );
    const calls = [];
    const service = createService();
    const ctx = {
      call: jest.fn(async (action, params) => {
        calls.push({ action, params });
        return false;
      })
    };

    const allowed = await service.isActorAllowedByAudience(ctx, pollWithAudience(audience), actorUri);

    expect(allowed).toBe(false);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every(call => call.params.query.length < 66_500)).toBe(true);
    const valueCounts = calls.map(call => (call.params.query.match(/<https:\/\/example\.test\/users\/alice\/collections\//g) || []).length);
    expect(valueCounts.every(count => count > 0 && count < 40)).toBe(true);
    expect(valueCounts.reduce((sum, count) => sum + count, 0)).toBe(40);
  });

  test('validated RDF IRIs are not URL-canonicalized before membership lookup', async () => {
    const actorUri = 'https://remote.example';
    const collectionUri = 'https://example.test/users/alice/followers';
    let query;
    const service = createService();
    const ctx = {
      call: jest.fn(async (_action, params) => {
        query = params.query;
        return false;
      })
    };

    await service.isActorAllowedByAudience(ctx, pollWithAudience([collectionUri]), actorUri);

    expect(query).toContain('as:items <https://remote.example>');
    expect(query).not.toContain('as:items <https://remote.example/>');
  });

  test('failed batch recursively isolates collections so a later member can still authorize', async () => {
    const actorUri = 'https://remote.example/users/bob';
    const first = 'https://example.test/users/alice/followers';
    const second = 'https://example.test/users/alice/collections/friends';
    const calls = [];
    const service = createService();
    const ctx = {
      call: jest.fn(async (action, params) => {
        calls.push({ action, params });
        const hasFirst = params.query.includes(`<${first}>`);
        const hasSecond = params.query.includes(`<${second}>`);
        if (hasFirst && hasSecond) throw new Error('batch-specific failure');
        if (hasFirst) throw new Error('first collection failure');
        return hasSecond;
      })
    };

    const allowed = await service.isActorAllowedByAudience(ctx, pollWithAudience([first, second]), actorUri);

    expect(allowed).toBe(true);
    expect(calls).toHaveLength(3);
    expect(service.logger.warn).toHaveBeenCalledTimes(1);
    expect(service.logger.warn.mock.calls[0][1].collectionUri).toBe(first);
  });

  test('unsafe collection IRI is skipped without interpolating it into SPARQL', async () => {
    const actorUri = 'https://remote.example/users/bob';
    const unsafe = 'https://example.test/users/alice/collections/<bad>';
    const safe = 'https://example.test/users/alice/followers';
    let query;
    const service = createService();
    const ctx = {
      call: jest.fn(async (_action, params) => {
        query = params.query;
        return false;
      })
    };

    const allowed = await service.isActorAllowedByAudience(ctx, pollWithAudience([unsafe, safe]), actorUri);

    expect(allowed).toBe(false);
    expect(query).toContain(`<${safe}>`);
    expect(query).not.toContain(unsafe);
    expect(service.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('invalid collection URI'),
      expect.objectContaining({ collectionUri: unsafe })
    );
  });
});
