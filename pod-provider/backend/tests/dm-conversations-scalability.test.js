'use strict';

const schema = require('../services/dm-conversations.service');

function createService(overrides = {}) {
  return {
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    ...schema.methods,
    ...overrides
  };
}

describe('DM conversation SPARQL scalability', () => {
  test('pages conversation nodes in a subquery before expanding participants', async () => {
    const actorUri = 'https://example.test/alice';
    const graph = `${actorUri}/dm-conversations`;
    const nodeA = `${graph}/11111111-1111-4111-8111-111111111111`;
    const nodeB = `${graph}/22222222-2222-4222-8222-222222222222`;
    const queries = [];
    const service = createService({
      triQuery: jest.fn(async (_ctx, query, dataset) => {
        queries.push({ query, dataset });
        return [
          {
            node: { value: nodeA },
            convId: { value: '11111111-1111-4111-8111-111111111111' },
            participant: { value: actorUri },
            lastMessageAt: { value: '2026-08-15T18:00:00.000Z' },
            created: { value: '2026-08-15T17:00:00.000Z' }
          },
          {
            node: { value: nodeA },
            convId: { value: '11111111-1111-4111-8111-111111111111' },
            participant: { value: 'https://remote.test/bob' },
            lastMessageAt: { value: '2026-08-15T18:00:00.000Z' },
            created: { value: '2026-08-15T17:00:00.000Z' }
          },
          {
            node: { value: nodeB },
            convId: { value: '22222222-2222-4222-8222-222222222222' },
            participant: { value: actorUri },
            lastMessageAt: { value: '2026-08-15T16:00:00.000Z' },
            created: { value: '2026-08-15T15:00:00.000Z' }
          },
          {
            node: { value: nodeB },
            convId: { value: '22222222-2222-4222-8222-222222222222' },
            participant: { value: 'https://remote.test/carol' },
            lastMessageAt: { value: '2026-08-15T16:00:00.000Z' },
            created: { value: '2026-08-15T15:00:00.000Z' }
          }
        ];
      })
    });

    const result = await schema.actions.list.call(service, {
      params: { actorUri, limit: 2, offset: 3 }
    });

    expect(result).toEqual([
      {
        conversationId: '11111111-1111-4111-8111-111111111111',
        participantUris: [actorUri, 'https://remote.test/bob'],
        lastMessageAt: '2026-08-15T18:00:00.000Z',
        createdAt: '2026-08-15T17:00:00.000Z'
      },
      {
        conversationId: '22222222-2222-4222-8222-222222222222',
        participantUris: [actorUri, 'https://remote.test/carol'],
        lastMessageAt: '2026-08-15T16:00:00.000Z',
        createdAt: '2026-08-15T15:00:00.000Z'
      }
    ]);
    expect(queries).toHaveLength(1);
    const query = queries[0].query;
    expect(query).toContain('SELECT ?node ?convId ?participant ?lastMessageAt ?created');
    expect(query).toContain('SELECT ?node ?convId ?lastMessageAt ?created WHERE');
    expect(query).toContain('ORDER BY DESC(?lastMessageAt) ?convId');
    expect(query).toContain('LIMIT 2');
    expect(query).toContain('OFFSET 3');
    expect(query).not.toContain('LIMIT 40');
    expect(query).toContain('?node dm:participant ?participant');
    expect(query).not.toContain('VALUES ?node');
  });

  test('empty conversation page remains one bounded query', async () => {
    const service = createService({ triQuery: jest.fn(async () => []) });

    await expect(
      schema.actions.list.call(service, { params: { actorUri: 'https://example.test/alice', limit: 20 } })
    ).resolves.toEqual([]);
    expect(service.triQuery).toHaveBeenCalledTimes(1);
    expect(service.triQuery.mock.calls[0][1]).toContain('LIMIT 20');
  });

  test('pushes participant autocomplete filtering before the bounded LIMIT', async () => {
    const queries = [];
    const service = createService({
      triQuery: jest.fn(async (_ctx, query, dataset) => {
        queries.push({ query, dataset });
        return [{ participant: { value: 'https://remote.test/users/Bob' } }];
      })
    });

    const result = await schema.actions.listParticipants.call(service, {
      params: { actorUri: 'https://example.test/alice', query: 'BOB', limit: 7 }
    });

    expect(result).toEqual(['https://remote.test/users/Bob']);
    expect(queries).toHaveLength(1);
    expect(queries[0].query).toContain('FILTER(CONTAINS(LCASE(STR(?participant)), "bob"))');
    expect(queries[0].query).toContain('LIMIT 7');
    expect(queries[0].query).not.toContain('LIMIT 70');
  });

  test('SPARQL-escapes participant autocomplete text', async () => {
    const service = createService({ triQuery: jest.fn(async () => []) });
    const hostile = 'bob")) . ?s ?p ?o . #';

    await schema.actions.listParticipants.call(service, {
      params: { actorUri: 'https://example.test/alice', query: hostile, limit: 5 }
    });

    const query = service.triQuery.mock.calls[0][1];
    expect(query).toContain(JSON.stringify(hostile.toLowerCase()));
    expect(query).toContain('LIMIT 5');
  });
});
