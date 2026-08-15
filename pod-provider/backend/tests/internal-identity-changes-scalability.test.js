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
  test('selects only cursor fields with keyset pagination before authoritative reads', async () => {
    const service = createService();
    const ctx = {
      call: jest.fn(async (action, params) => {
        if (action === 'triplestore.query') {
          expect(params.dataset).toBe('settings');
          expect(params.webId).toBe('system');
          expect(params.query).toContain('apods:updatedAt ?updatedAt');
          expect(params.query).toContain('apods:canonicalAccountId ?canonicalAccountId');
          expect(params.query).toContain('ORDER BY ?updatedAt ?canonicalAccountId');
          expect(params.query).toContain('LIMIT 25');
          expect(params.query).not.toContain('?atprotoDid');
          expect(params.query).not.toContain('?repoRootCid');
          return [
            {
              canonicalAccountId: { value: 'https://example.test/alice' },
              updatedAt: { value: '2026-08-15T10:00:00.000Z' }
            }
          ];
        }
        throw new Error(`unexpected action ${action}`);
      })
    };

    const rows = await service.selectChangePage(ctx, null, 25);
    expect(rows).toEqual([
      {
        canonicalAccountId: 'https://example.test/alice',
        updatedAt: '2026-08-15T10:00:00.000Z'
      }
    ]);
  });

  test('cursor filter is strict and tie-breaks on canonical account id', async () => {
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
        updatedAt: '2026-08-15T10:00:00.000Z',
        canonicalAccountId: 'https://example.test/alice'
      },
      100
    );

    expect(query).toContain('?updatedAt > "2026-08-15T10:00:00.000Z"');
    expect(query).toContain('?updatedAt = "2026-08-15T10:00:00.000Z"');
    expect(query).toContain('?canonicalAccountId > "https://example.test/alice"');
  });

  test('advances past stale index rows without getting stuck', async () => {
    const service = createService();
    const calls = [];
    const ctx = {
      params: { limit: 2 },
      call: jest.fn(async (action, params) => {
        calls.push({ action, params });
        if (action === 'triplestore.query') {
          return [
            {
              canonicalAccountId: { value: 'https://example.test/stale' },
              updatedAt: { value: '2026-08-15T10:00:00.000Z' }
            },
            {
              canonicalAccountId: { value: 'https://example.test/bob' },
              updatedAt: { value: '2026-08-15T10:00:01.000Z' }
            }
          ];
        }
        if (action === 'identitybindings.getByCanonicalAccountId') {
          if (params.canonicalAccountId.endsWith('/stale')) return null;
          return {
            canonicalAccountId: params.canonicalAccountId,
            webId: params.canonicalAccountId,
            updatedAt: '2026-08-15T10:00:01.000Z',
            status: 'active'
          };
        }
        throw new Error(`unexpected action ${action}`);
      })
    };

    const result = await schema.actions.listChanges.handler.call(service, ctx);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].canonicalAccountId).toBe('https://example.test/bob');
    expect(service.parseCursor(result.nextCursor)).toEqual({
      updatedAt: '2026-08-15T10:00:01.000Z',
      canonicalAccountId: 'https://example.test/bob'
    });
    expect(calls.filter(call => call.action === 'identitybindings.getByCanonicalAccountId')).toHaveLength(2);
  });

  test('rejects malformed cursors', () => {
    const service = createService();
    expect(() => service.parseCursor('not-base64-json')).toThrow('Invalid cursor');
  });
});
