'use strict';

const signingService = require('../services/signing.service');
const {
  MAX_AUTHORIZATION_HEADER_BYTES,
  configuredSigningToken,
  isDateWithinSkew,
  parseBearerToken,
  timingSafeSecretEqual
} = require('../utils/signing-security');

function expectMoleculerError(fn, { code, type, message }) {
  try {
    fn();
    throw new Error('expected function to throw');
  } catch (error) {
    expect(error.code).toBe(code);
    expect(error.type).toBe(type);
    expect(error.message).toMatch(message);
  }
}

describe('signing internal authentication hardening', () => {
  test('requires an explicit ACTIVITYPODS_TOKEN and never falls back to other shared secrets', () => {
    expect(configuredSigningToken({})).toBeNull();
    expect(configuredSigningToken({ SIDECAR_TOKEN: 'sidecar-only' })).toBeNull();
    expect(configuredSigningToken({ ACTIVITYPODS_TOKEN: '' })).toBeNull();
    expect(configuredSigningToken({ ACTIVITYPODS_TOKEN: 'token with spaces' })).toBeNull();
    expect(configuredSigningToken({ ACTIVITYPODS_TOKEN: 'valid-token_123' })).toBe('valid-token_123');
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
      { code: 503, type: 'SIGNING_AUTH_NOT_CONFIGURED', message: /not configured/u }
    );
  });

  test('service auth distinguishes missing/malformed credentials from an invalid bearer secret', () => {
    const service = { settings: { auth: { bearerToken: 'expected-secret' } } };

    expectMoleculerError(
      () => signingService.methods._auth.call(service, { meta: { $headers: {} } }),
      { code: 401, type: 'AUTH_FAILED', message: /missing or malformed/u }
    );
    expectMoleculerError(
      () => signingService.methods._auth.call(service, { meta: { $headers: { authorization: 'Bearer wrong-secret' } } }),
      { code: 403, type: 'AUTH_FAILED', message: /invalid bearer token/u }
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
