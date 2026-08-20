'use strict';

const crypto = require('crypto');
const signingService = require('../services/signing.service');
const {
  MAX_AUTHORIZATION_HEADER_BYTES,
  MAX_BEARER_TOKEN_BYTES,
  MIN_SIGNING_TOKEN_BYTES,
  configuredSigningToken,
  isDateWithinSkew,
  parseBearerToken,
  timingSafeSecretEqual
} = require('../utils/signing-security');

function captureError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected function to throw');
}

function expectMoleculerError(fn, { code, type, message }) {
  const error = captureError(fn);
  expect(error.code).toBe(code);
  expect(error.type).toBe(type);
  expect(error.message).toMatch(message);
}

describe('signing internal authentication hardening', () => {
  test('requires a dedicated ACTIVITYPODS_TOKEN and never falls back to other shared secrets', () => {
    const validToken = 'a'.repeat(MIN_SIGNING_TOKEN_BYTES);
    expect(configuredSigningToken({})).toBeNull();
    expect(configuredSigningToken({ SIDECAR_TOKEN: 'a'.repeat(64) })).toBeNull();
    expect(configuredSigningToken({ SIGNING_API_TOKEN: 'a'.repeat(64) })).toBeNull();
    expect(configuredSigningToken({ ACTIVITYPODS_TOKEN: 'a'.repeat(MIN_SIGNING_TOKEN_BYTES - 1) })).toBeNull();
    expect(configuredSigningToken({ ACTIVITYPODS_TOKEN: validToken })).toBe(validToken);
  });

  test('keeps configured token bounds compatible with the accepted Authorization header', () => {
    const maxToken = 'a'.repeat(MAX_BEARER_TOKEN_BYTES);
    expect(Buffer.byteLength(`Bearer ${maxToken}`, 'utf8')).toBe(MAX_AUTHORIZATION_HEADER_BYTES);
    expect(configuredSigningToken({ ACTIVITYPODS_TOKEN: maxToken })).toBe(maxToken);
    expect(parseBearerToken(`Bearer ${maxToken}`)).toBe(maxToken);
    expect(configuredSigningToken({ ACTIVITYPODS_TOKEN: 'a'.repeat(MAX_BEARER_TOKEN_BYTES + 1) })).toBeNull();
  });

  test('strictly parses bearer credentials', () => {
    expect(parseBearerToken('Bearer abc.DEF_123-~+/==')).toBe('abc.DEF_123-~+/==');
    expect(parseBearerToken('bearer abc123')).toBe('abc123');
    expect(parseBearerToken('Basic abc123')).toBeNull();
    expect(parseBearerToken('Bearer  abc123')).toBeNull();
    expect(parseBearerToken('Bearer abc123 extra')).toBeNull();
  });

  test('uses timing-safe fixed-size secret comparison', () => {
    expect(timingSafeSecretEqual('same-secret', 'same-secret')).toBe(true);
    expect(timingSafeSecretEqual('same-secret', 'different-secret')).toBe(false);
    expect(timingSafeSecretEqual('short', 'a-much-longer-secret')).toBe(false);
    expect(timingSafeSecretEqual('', 'expected')).toBe(false);
  });

  test('service auth fails closed when signing auth is unconfigured', () => {
    const service = { settings: { auth: { bearerToken: null } } };
    expectMoleculerError(
      () => signingService.methods._auth.call(service, { meta: { $headers: { authorization: 'Bearer supplied' } } }),
      { code: 503, type: 'SIGNING_AUTH_NOT_CONFIGURED', message: /not configured/iu }
    );
  });

  test('service auth distinguishes malformed and invalid credentials', () => {
    const expected = 'e'.repeat(32);
    const service = { settings: { auth: { bearerToken: expected } } };
    expectMoleculerError(
      () => signingService.methods._auth.call(service, { meta: { $headers: {} } }),
      { code: 401, type: 'AUTH_FAILED', message: /missing or malformed/iu }
    );
    expectMoleculerError(
      () => signingService.methods._auth.call(service, { meta: { $headers: { authorization: `Bearer ${'w'.repeat(32)}` } } }),
      { code: 403, type: 'AUTH_FAILED', message: /invalid bearer token/iu }
    );
    expect(() => signingService.methods._auth.call(service, {
      meta: { $headers: { authorization: `Bearer ${expected}` } }
    })).not.toThrow();
  });
});

describe('signing HTTP date replay protection', () => {
  const now = Date.parse('Mon, 17 Aug 2026 20:00:00 GMT');

  test('accepts only canonical IMF-fixdate within skew', () => {
    expect(isDateWithinSkew('Mon, 17 Aug 2026 20:00:00 GMT', 300, now)).toBe(true);
    expect(isDateWithinSkew('Mon, 17 Aug 2026 19:55:00 GMT', 300, now)).toBe(true);
    expect(isDateWithinSkew('Mon, 17 Aug 2026 20:05:01 GMT', 300, now)).toBe(false);
    expect(isDateWithinSkew('2026-08-17T20:00:00Z', 300, now)).toBe(false);
    expect(isDateWithinSkew('Tue, 17 Aug 2026 20:00:00 GMT', 300, now)).toBe(false);
    expect(isDateWithinSkew('Mon, 32 Aug 2026 20:00:00 GMT', 300, now)).toBe(false);
  });

  test('service boundary rejects malformed caller Date before signing', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 1024,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    const service = {
      settings: { limits: { maxBodyBytes: 1024, maxClockSkewSeconds: 300 }, profiles: signingService.settings.profiles },
      _err: signingService.methods._err,
      _parseBodyBytes: signingService.methods._parseBodyBytes,
      _validateDateSkew: signingService.methods._validateDateSkew
    };
    const request = {
      requestId: 'date-negative',
      method: 'GET',
      profile: 'ap_get_v1',
      target: { host: 'remote.example', path: '/inbox' },
      headers: { date: 'definitely-not-an-http-date' }
    };

    await expect(signingService.methods._signOne.call(
      service,
      {},
      'https://pods.example/alice',
      'https://pods.example/alice#main-key',
      privateKey,
      request
    )).resolves.toEqual({
      requestId: 'date-negative',
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'date invalid or skew too large', retryable: false }
    });
  });
});

describe('ATProto provisioning authority binding', () => {
  test('rejects a mismatched webId before key or binding mutation', async () => {
    const ctx = {
      params: { canonicalAccountId: 'https://pods.example/alice', webId: 'https://pods.example/bob' },
      meta: {},
      call: jest.fn()
    };
    const service = { _auth: jest.fn() };
    await expect(signingService.actions.provisionAtprotoIdentity.handler.call(service, ctx)).rejects.toMatchObject({
      code: 403,
      type: 'ACCOUNT_BINDING_MISMATCH'
    });
    expect(ctx.call).not.toHaveBeenCalled();
  });

  test('rejects non-HTTP canonical account IDs before key generation', async () => {
    const ctx = { params: { canonicalAccountId: 'did:example:alice' }, meta: {}, call: jest.fn() };
    const service = { _auth: jest.fn() };
    await expect(signingService.actions.provisionAtprotoIdentity.handler.call(service, ctx)).rejects.toMatchObject({
      code: 400,
      type: 'INVALID_INPUT'
    });
    expect(ctx.call).not.toHaveBeenCalled();
  });

  test('rejects an HTTP WebID that is not bound to a local account before any key mutation', async () => {
    const ctx = {
      params: { canonicalAccountId: 'https://remote.example/alice' },
      meta: {},
      call: jest.fn().mockResolvedValueOnce(null)
    };
    const service = { _auth: jest.fn() };

    await expect(signingService.actions.provisionAtprotoIdentity.handler.call(service, ctx)).rejects.toMatchObject({
      code: 403,
      type: 'ACCOUNT_NOT_LOCAL'
    });
    expect(ctx.call).toHaveBeenCalledTimes(1);
    expect(ctx.call).toHaveBeenCalledWith('auth.account.findByWebId', { webId: 'https://remote.example/alice' });
  });

  test('uses the authoritative local account dataset for AT key creation', async () => {
    const canonicalAccountId = 'https://pods.example/alice';
    const ctx = {
      params: { canonicalAccountId, did: 'did:plc:alice', handle: 'alice.example' },
      meta: { requestId: 'req-1' },
      call: jest.fn()
        .mockResolvedValueOnce({ webId: canonicalAccountId, username: 'alice-dataset' })
        .mockResolvedValueOnce({ keyRef: 'commit-key' })
        .mockResolvedValueOnce({ keyRef: 'rotation-key' })
        .mockResolvedValueOnce({ canonicalAccountId, webId: canonicalAccountId })
    };
    const service = { _auth: jest.fn() };

    await signingService.actions.provisionAtprotoIdentity.handler.call(service, ctx);

    expect(ctx.call).toHaveBeenNthCalledWith(1, 'auth.account.findByWebId', { webId: canonicalAccountId });
    expect(ctx.call).toHaveBeenNthCalledWith(
      2,
      'keys.generateSecp256k1Key',
      { webId: canonicalAccountId },
      { meta: { requestId: 'req-1', dataset: 'alice-dataset', webId: canonicalAccountId } }
    );
    expect(ctx.call).toHaveBeenNthCalledWith(
      3,
      'keys.generateSecp256k1Key',
      { webId: canonicalAccountId },
      { meta: { requestId: 'req-1', dataset: 'alice-dataset', webId: canonicalAccountId } }
    );
  });
});
