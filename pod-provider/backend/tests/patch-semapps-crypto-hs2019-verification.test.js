'use strict';

const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const { MARKER, patchHttpSignatures } = require('../scripts/patch-semapps-crypto-hs2019-verification');

const semappsFile = require.resolve('@semapps/crypto/signature/http-signatures');

function loadPatchedService(source) {
  const compiled = new Module(semappsFile, module);
  compiled.filename = semappsFile;
  compiled.paths = Module._nodeModulePaths(path.dirname(semappsFile));
  compiled._compile(source, semappsFile);
  return compiled.exports;
}

function signedRequest(algorithm = 'hs2019') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const date = new Date().toUTCString();
  const signingString = `(request-target): get /actor\nhost: remote.example\ndate: ${date}`;
  const signature = crypto.sign('sha256', Buffer.from(signingString), privateKey).toString('base64');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    params: {
      url: 'https://remote.example/actor',
      method: 'GET',
      headers: {
        host: 'remote.example',
        date,
        signature: `keyId="https://sender.example/users/alice#main-key",algorithm="${algorithm}",headers="(request-target) host date",signature="${signature}"`
      }
    }
  };
}

describe('SemApps hs2019 HTTP signature verification patch', () => {
  const original = fs.readFileSync(semappsFile, 'utf8').replace(
    /\nfunction normalizeHs2019RsaSignatureAlgorithm[\s\S]*?\/\/ activitypods-hs2019-rsa-sha256-verification-v1\n\n/,
    '\n'
  ).replace('headers: normalizeHs2019RsaSignatureAlgorithm(headers)', 'headers');

  test('is wired into postinstall and copied before production dependency installation', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
    expect(packageJson.scripts.postinstall).toContain('node scripts/patch-semapps-crypto-hs2019-verification.js');

    const dockerfile = fs.readFileSync(path.resolve(__dirname, '../../docker/backend.dockerfile'), 'utf8');
    const copyIndex = dockerfile.indexOf(
      'ADD backend/scripts/patch-semapps-crypto-hs2019-verification.js /app/backend/scripts/patch-semapps-crypto-hs2019-verification.js'
    );
    expect(copyIndex).toBeGreaterThan(-1);
    expect(dockerfile.indexOf('RUN yarn install && yarn cache clean')).toBeGreaterThan(copyIndex);
  });

  test('accepts a valid hs2019-declared RSA-SHA256 signature through cryptographic verification', async () => {
    const service = loadPatchedService(patchHttpSignatures(original).source);
    const request = signedRequest();
    const result = await service.actions.verifyHttpSignature({
      params: request.params,
      call: jest.fn().mockResolvedValue([{ publicKeyPem: request.publicKeyPem }])
    });

    expect(result).toMatchObject({ isValid: true, actorUri: 'https://sender.example/users/alice' });
    expect(result.publicKeyPem).toBe(request.publicKeyPem);
  });

  test('rejects a tampered hs2019 signature', async () => {
    const service = loadPatchedService(patchHttpSignatures(original).source);
    const request = signedRequest();
    request.params.headers.host = 'attacker.example';

    await expect(service.actions.verifyHttpSignature({
      params: request.params,
      call: jest.fn().mockResolvedValue([{ publicKeyPem: request.publicKeyPem }])
    })).resolves.toMatchObject({ isValid: false });
  });

  test('does not reinterpret unknown algorithms or ambiguous duplicate declarations', async () => {
    const service = loadPatchedService(patchHttpSignatures(original).source);
    const unknown = signedRequest('not-supported');
    let unknownError;
    try {
      await service.actions.verifyHttpSignature({ params: unknown.params, call: jest.fn() });
    } catch (error) {
      unknownError = error;
    }
    expect(unknownError).toMatchObject({ message: 'not-supported is not supported' });

    const duplicate = signedRequest();
    duplicate.params.headers.signature += ',algorithm="rsa-sha256"';
    let duplicateError;
    try {
      await service.actions.verifyHttpSignature({ params: duplicate.params, call: jest.fn() });
    } catch (error) {
      duplicateError = error;
    }
    expect(duplicateError).toMatchObject({ message: 'Multiple HTTP Signature algorithm parameters are not supported' });
  });

  test('is idempotent only while the complete compatibility contract remains present', () => {
    const once = patchHttpSignatures(original);
    expect(once.changed).toBe(true);
    expect(once.source).toContain(MARKER);
    expect(patchHttpSignatures(once.source)).toEqual({ source: once.source, changed: false });
    expect(() => patchHttpSignatures(`// ${MARKER}`)).toThrow('complete verification contract');
  });

  test('fails closed when the pinned SemApps source contract drifts', () => {
    expect(() => patchHttpSignatures('no service declaration')).toThrow('HTTP signature service declaration');
    expect(() => patchHttpSignatures(original.replace('        headers\n      });', '        requestHeaders: headers\n      });')))
      .toThrow('HTTP signature parser headers');
  });
});
