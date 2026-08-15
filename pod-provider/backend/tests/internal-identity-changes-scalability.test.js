'use strict';

const schema = require('../services/internal-identity-changes.service');

function createService(overrides = {}) {
  return {
    ...schema.methods,
    logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() },
    ...overrides
  };
}

describe('internal identity change feed scalability', () => {
  test('selects a bounded coherent projection page with keyset pagination', async () => {
    const service = createService();
    const ctx = {
      call: jest.fn(async (action, params) => {
        if (action === 'triplestore.query') {
          expect(params.dataset).toBe('settings');
          expect(params.webId).toBe('system');
          expect(params.query).toContain('apods:updatedAt ?updatedAt');
          expect(params.query).toContain('apods:canonicalAccountId ?canonicalAccountId');
          expect(params.query).toContain('?atprotoDid');
          expect(params.query).toContain('?repoRootCid');
          expect(params.query).toContain('ORDER BY ?updatedAt ?canonicalAccountId');
          expect(params.query).toContain('LIMIT 25');
          return [
            {
              canonicalAccountId: { value: 'https://example.test/alice' },
              webId: { value: 'https://example.test/alice' },
              atprotoDid: { value: 'did:plc:alice' },
              status: { value: 'active' },
              updatedAt: { value: '2026-08-15T10:00:00.000Z' }
            }
          ];
        }
        throw new Error(`unexpected action ${action}`);
      })
    };

    const rows = await service.selectChangePage(ctx, null, 25);
    expect(rows[0]).toMatchObject({
      canonicalAccountId: 'https://example.test/alice',
      webId: 'https://example.test/alice',
      atprotoDid: 'did:plc:alice',
      status: 'active',
      updatedAt: '2026-08-15T10:00:00.000Z'
    });
    expect(ctx.call).toHaveBeenCalledTimes(1);
  });

  test('v2 cursor filter is strict and tie-breaks on canonical account id', async () => {
    const service = createService();
    let query = '';
    const ctx = {
      call: jest.fn(async (_action, params) => {
        query = params.query;
        return [];
      })
    };

    await service.selectChangePage(
      ctx,
      {
        version: 2,
        updatedAt: '2026-08-15T10:00:00.000Z',
        canonicalAccountId: 'https://example.test/alice'
      },
      100
    );

    expect(query).toContain('?updatedAt > "2026-08-15T10:00:00.000Z"');
    expect(query).toContain('?updatedAt = "2026-08-15T10:00:00.000Z"');
    expect(query).toContain('?canonicalAccountId > "https://example.test/alice"');
  });

  test('new drain returns projection snapshots directly and a versioned cursor', async () => {
    const service = createService();
    const ctx = {
      params: { limit: 2 },
      call: jest.fn(async action => {
        if (action === 'triplestore.query') {
          return [
            {
              canonicalAccountId: { value: 'https://example.test/alice' },
              webId: { value: 'https://example.test/alice' },
              status: { value: 'active' },
              updatedAt: { value: '2026-08-15T10:00:00.000Z' }
            },
            {
              canonicalAccountId: { value: 'https://example.test/bob' },
              webId: { value: 'https://example.test/bob' },
              status: { value: 'active' },
              updatedAt: { value: '2026-08-15T10:00:01.000Z' }
            }
          ];
        }
        throw new Error(`unexpected action ${action}`);
      })
    };

    const result = await schema.actions.listChanges.handler.call(service, ctx);
    expect(result.items).toHaveLength(2);
    expect(result.items.map(item => item.canonicalAccountId)).toEqual([
      'https://example.test/alice',
      'https://example.test/bob'
    ]);
    expect(service.parseCursor(result.nextCursor)).toEqual({
      version: 2,
      updatedAt: '2026-08-15T10:00:01.000Z',
      canonicalAccountId: 'https://example.test/bob'
    });
    expect(ctx.call).toHaveBeenCalledTimes(1);
  });

  test('legacy cursors retain localeCompare-compatible identitybindings path', async () => {
    const service = createService();
    const legacyCursor = Buffer.from(
      JSON.stringify({
        updatedAt: '2026-08-15T10:00:00.000Z',
        canonicalAccountId: 'https://example.test/Alice'
      }),
      'utf8'
    ).toString('base64url');
    const ctx = {
      params: { since: legacyCursor, limit: 20 },
      call: jest.fn(async (action, params) => {
        expect(action).toBe('identitybindings.list');
        expect(params).toEqual({ since: legacyCursor, limit: 20 });
        return {
          items: [
            {
              canonicalAccountId: 'https://example.test/bob',
              webId: 'https://example.test/bob',
              status: 'active',
              updatedAt: '2026-08-15T10:00:01.000Z'
            }
          ],
          nextCursor: 'legacy-next'
        };
      })
    };

    const result = await schema.actions.listChanges.handler.call(service, ctx);
    expect(result.items[0].canonicalAccountId).toBe('https://example.test/bob');
    expect(result.nextCursor).toBe('legacy-next');
    expect(ctx.call).toHaveBeenCalledTimes(1);
  });

  test('rejects malformed cursors', () => {
    const service = createService();
    expect(() => service.parseCursor('not-base64-json')).toThrow('Invalid cursor');
  });
});
