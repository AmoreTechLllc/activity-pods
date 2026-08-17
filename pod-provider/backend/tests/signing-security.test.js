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
  test('requires an explicit high-entropy ACTIVITYPODS_TOKEN and never falls back to other shared secrets', () => {
    const validToken = 'a'.repeat(MIN_SIGNING_TOKEN_BYTES);

    expect(configuredSigningToken({})).toBeNull();
    expect(configuredSigningToken({ SIDECAR_TOKEN: 'sidecar-only' })).toBeNull();
    expect(configuredSigningToken({ ACTIVITYPODS_TOKEN: '' })).toBeNull();
    expect(configuredSigningToken({ ACTIVITYPODS_TOKEN: 'a'.repeat(MIN_SIGNING_TOKEN_BYTES - 1) })).toBeNull();
    expect(configuredSigningToken({ ACTIVITYPODS_TOKEN: 'token with spaces'.padEnd(MIN_SIGNING_TOKEN_BYTES, 'x') })).toBeNull();
    expect(configuredSigningToken({ ACTIVITYPODS_TOKEN: validToken })).toBe(validToken);
  });

  test('keeps configured token bounds compatible with the maximum accepted Authorization header', () => {
    const maxToken = 'a'.repeat(MAX_BEARER_TOKEN_BYTES);
    const tooLargeToken = 'a'.repeat(MAX_BEARER_TOKEN_BYTES + 1);

    expect(Buffer.byteLength(`Bearer ${maxToken}`, 'utf8')).toBe(MAX_AUTHORIZATION_HEADER_BYTES);
    expect(configuredSigningToken({ ACTIVITYPODS_TOKEN: maxToken })).toBe(maxToken);
    expect(parseBearerToken(`Bearer ${maxToken}`)).toBe(maxToken);
    expect(configuredSigningToken({ ACTIVITYPODS_TOKEN: tooLargeToken })).toBeNull();
    expect(parseBearerToken(`Bearer ${tooLargeToken}`)).toBeNull();
  });

  test('parses RFC 6750 bearer tokens strictly and rejects oversized or ambiguous headers', () => {
    expect(parseBearerToken('Bearer abc.DEF_123-~+/==')).toBe('abc.DEF_123-~+/==');
    expect(parseBearerToken('bearer abc123')).toBe('abc123');
    expect(parseBearerToken('Basic abc123')).toBeNull();
    expect(parseBearerToken('Bearer')).toBeNull();
    expect(parseBearerToken('Bearer  abc123')).toBeNull();
    expect(parseBearerToken('Bearer abc123 extra')).toBeNull();
    expect(parseBearerToken(`Bearer ${'a'.repeat(MAX_AUTHORIZATION_HEADER_BYTES)}`)).toBeNull();
  });

  test('compares secrets through fixed-size timing-safe digests', () => {
    expect(timingSafeSecretEqual('same-secret', 'same-secret')).toBe(true);
    expect(timingSafeSecretEqual('same-secret', 'different-secret')).toBe(false);
    expect(timingSafeSecretEqual('short', 'a-much-longer-secret')).toBe(false);
    expect(timingSafeSecretEqual('', 'expected')).toBe(false);
    expect(timingSafeSecretEqual(null, 'expected')).toBe(false);
  });

  test('service auth fails closed when signing auth is not configured', () => {
    const service = { settings: { auth: { bearerToken: null } } };
    expectMoleculerError(
      () => signingService.methods._auth.call(service, { meta: { $headers: { authorization: 'Bearer supplied' } } }),
      { code: 503, type: 'SIGNING_AUTH_NOT_CONFIGURED', message: /not configured/iu }
    );
  });

  test('service auth distinguishes missing/malformed credentials from an invalid bearer secret', () => {
    const service = { settings: { auth: { bearerToken: 'expected-secret' } } };

    expectMoleculerError(
      () => signingService.methods._auth.call(service, { meta: { $headers: {} } }),
      { code: 401, type: 'AUTH_FAILED', message: /missing or malformed/iu }
    );
    expectMoleculerError(
      () => signingService.methods._auth.call(service, { meta: { $headers: { authorization: 'Bearer wrong-secret' } } }),
      { code: 403, type: 'AUTH_FAILED', message: /invalid bearer token/iu }
    );
    expect(() =>
      signingService.methods._auth.call(service, {
        meta: { $headers: { authorization: 'Bearer expected-secret' } }
      })
    ).not.toThrow();
  });
});

describe('signing HTTP date replay protection', () => {
  const now = Date.parse('Mon, 17 Aug 2026 20:00:00 GMT');

  test('accepts canonical IMF-fixdate values only within the configured skew window', () => {
    expect(isDateWithinSkew('Mon, 17 Aug 2026 20:00:00 GMT', 300, now)).toBe(true);
    expect(isDateWithinSkew('Mon, 17 Aug 2026 19:55:00 GMT', 300, now)).toBe(true);
    expect(isDateWithinSkew('Mon, 17 Aug 2026 20:05:00 GMT', 300, now)).toBe(true);
    expect(isDateWithinSkew('Mon, 17 Aug 2026 19:54:59 GMT', 300, now)).toBe(false);
    expect(isDateWithinSkew('Mon, 17 Aug 2026 20:05:01 GMT', 300, now)).toBe(false);
  });

  test('rejects malformed, impossible, non-HTTP, and weekday-mismatched dates instead of failing open', () => {
    expect(isDateWithinSkew('not-a-date', 300, now)).toBe(false);
    expect(isDateWithinSkew('2026-08-17T20:00:00Z', 300, now)).toBe(false);
    expect(isDateWithinSkew('Mon, 32 Aug 2026 20:00:00 GMT', 300, now)).toBe(false);
    expect(isDateWithinSkew('Tue, 17 Aug 2026 20:00:00 GMT', 300, now)).toBe(false);
    expect(isDateWithinSkew('Mon, 17 Aug 2026 20:00:00 UTC', 300, now)).toBe(false);
    expect(isDateWithinSkew('Mon, 17 Aug 2026 20:00:00 GMT', -1, now)).toBe(false);
  });

  test('service boundary rejects a malformed caller-supplied Date before signing', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 1024,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    const service = {
      settings: {
        limits: { maxBodyBytes: 1024, maxClockSkewSeconds: 300 },
        profiles: signingService.settings.profiles
      },
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

    await expect(
      signingService.methods._signOne.call(
        service,
        {},
        'https://pods.example/alice',
        'https://pods.example/alice#main-key',
        privateKey,
        request
      )
    ).resolves.toEqual({
      requestId: 'date-negative',
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'date invalid or skew too large',
        retryable: false
      }
    });
  });
});

describe('ATProto provisioning authority binding', () => {
  test('rejects an explicit webId that does not match canonicalAccountId before any key or binding mutation', async () => {
    const ctx = {
      params: {
        canonicalAccountId: 'https://pods.example/alice',
        webId: 'https://pods.example/bob'
      },
      meta: {},
      call: jest.fn()
    };
    const service = { _auth: jest.fn() };

    await expect(signingService.actions.provisionAtprotoIdentity.handler.call(service, ctx)).rejects.toMatchObject({
      code: 403,
      type: 'ACCOUNT_BINDING_MISMATCH'
    });
    expect(service._auth).toHaveBeenCalledWith(ctx);
    expect(ctx.call).not.toHaveBeenCalled();
  });

  test('rejects a non-HTTP canonical account ID before generating keys', async () => {
    const ctx = {
      params: { canonicalAccountId: 'did:example:alice' },
      meta: {},
      call: jest.fn()
    };
    const service = { _auth: jest.fn() };

    await expect(signingService.actions.provisionAtprotoIdentity.handler.call(service, ctx)).rejects.toMatchObject({
      code: 400,
      type: 'INVALID_INPUT'
    });
    expect(ctx.call).not.toHaveBeenCalled();
  });

  test('provisions only the canonical account WebID and preserves dataset-scoped key creation', async () => {
    const canonicalAccountId = 'https://pods.example/alice';
    const binding = {
      canonicalAccountId,
      webId: canonicalAccountId,
      atprotoDid: 'did:plc:alice'
    };
    const ctx = {
      params: {
        canonicalAccountId,
        webId: canonicalAccountId,
        did: 'did:plc:alice',
        handle: 'alice.example'
      },
      meta: { requestId: 'req-1' },
      call: jest
        .fn()
        .mockResolvedValueOnce({ keyRef: 'commit-key' })
        .mockResolvedValueOnce({ keyRef: 'rotation-key' })
        .mockResolvedValueOnce(binding)
    };
    const service = { _auth: jest.fn() };

    await expect(signingService.actions.provisionAtprotoIdentity.handler.call(service, ctx)).resolves.toEqual({
      binding,
      commitKeyRef: 'commit-key',
      rotationKeyRef: 'rotation-key'
    });

    expect(ctx.call).toHaveBeenNthCalledWith(
      1,
      'keys.generateSecp256k1Key',
      { webId: canonicalAccountId },
      { meta: { requestId: 'req-1', dataset: 'alice', webId: canonicalAccountId } }
    );
    expect(ctx.call).toHaveBeenNthCalledWith(
      2,
      'keys.generateSecp256k1Key',
      { webId: canonicalAccountId },
      { meta: { requestId: 'req-1', dataset: 'alice', webId: canonicalAccountId } }
    );
    expect(ctx.call).toHaveBeenNthCalledWith(3, 'identitybindings.upsert', {
      canonicalAccountId,
      webId: canonicalAccountId,
      atprotoDid: 'did:plc:alice',
      atprotoHandle: 'alice.example',
      atSigningKeyRef: 'commit-key',
      atRotationKeyRef: 'rotation-key',
      status: 'active'
    });
  });
});
