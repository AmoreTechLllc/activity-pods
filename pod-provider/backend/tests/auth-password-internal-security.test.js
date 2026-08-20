'use strict';

const authPasswordService = require('../services/auth-password-internal.service');

function service(overrides = {}) {
  return {
    settings: { bearerToken: 'p'.repeat(32) },
    failureBuckets: new Map(),
    ...authPasswordService.methods,
    ...overrides
  };
}

describe('internal password verification capability', () => {
  test('uses a credential distinct from the federation signing token', () => {
    const verifier = service();
    expect(() => verifier._auth({
      meta: { $headers: { authorization: `Bearer ${'s'.repeat(32)}` } }
    })).toThrow(expect.objectContaining({ code: 401, type: 'AUTH_FAILED' }));

    expect(() => verifier._auth({
      meta: { $headers: { authorization: `Bearer ${'p'.repeat(32)}` } }
    })).not.toThrow();
  });

  test('fails closed when the dedicated verifier credential is not configured', () => {
    const verifier = service({ settings: { bearerToken: null } });
    expect(() => verifier._auth({ meta: { $headers: {} } })).toThrow(
      expect.objectContaining({ code: 503, type: 'AUTH_VERIFY_NOT_CONFIGURED' })
    );
  });

  test('collapses missing-account and wrong-password outcomes to the same external result', async () => {
    const missing = service({ _auth: jest.fn() });
    const missingCtx = {
      params: { canonicalAccountId: 'https://pods.example/missing', password: 'guess' },
      meta: {},
      call: jest.fn().mockResolvedValueOnce(null)
    };
    await expect(
      authPasswordService.actions.verify.handler.call(missing, missingCtx)
    ).resolves.toEqual({ ok: false, reason: 'invalid_credentials' });
    expect(missingCtx.meta.$statusCode).toBe(401);
    expect(missingCtx.call).toHaveBeenCalledTimes(1);

    const wrong = service({ _auth: jest.fn() });
    const wrongCtx = {
      params: { canonicalAccountId: 'https://pods.example/alice', password: 'guess' },
      meta: {},
      call: jest.fn()
        .mockResolvedValueOnce({ webId: 'https://pods.example/alice', username: 'alice' })
        .mockRejectedValueOnce(new Error('invalid password'))
    };
    await expect(
      authPasswordService.actions.verify.handler.call(wrong, wrongCtx)
    ).resolves.toEqual({ ok: false, reason: 'invalid_credentials' });
    expect(wrongCtx.meta.$statusCode).toBe(401);
    expect(wrongCtx.call).toHaveBeenCalledTimes(2);
  });

  test('returns scope only after authoritative account lookup and password verification', async () => {
    const verifier = service({ _auth: jest.fn() });
    const canonicalAccountId = 'https://pods.example/alice';
    const ctx = {
      params: { canonicalAccountId, password: 'correct' },
      meta: {},
      call: jest.fn()
        .mockResolvedValueOnce({ webId: canonicalAccountId, username: 'alice' })
        .mockResolvedValueOnce(true)
    };
    await expect(
      authPasswordService.actions.verify.handler.call(verifier, ctx)
    ).resolves.toEqual({ ok: true, scope: 'full' });
    expect(ctx.call).toHaveBeenNthCalledWith(1, 'auth.account.findByWebId', { webId: canonicalAccountId });
    expect(ctx.call).toHaveBeenNthCalledWith(2, 'auth.account.verify', {
      username: 'alice',
      password: 'correct'
    });
  });

  test('rate-limits repeated failures using a bounded hashed account bucket', () => {
    const verifier = service();
    const key = 'bucket-key';
    for (let i = 0; i < 10; i += 1) verifier._recordFailure(key, 1000 + i);
    expect(verifier._isRateLimited(key, 2000)).toBe(true);
    expect(verifier.failureBuckets.get(key).failures).toBe(10);
  });
});