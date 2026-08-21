'use strict';

const fs = require('fs');
const path = require('path');

const EXPECTED_VERSION = '1.1.4';
const MARKER = 'activitypods-hs2019-rsa-sha256-verification-v1';

const HELPER = `
function normalizeHs2019RsaSignatureAlgorithm(headers) {
  const signature = headers.signature;
  if (typeof signature !== 'string') return headers;

  const algorithmParameters = signature.match(/(?:^|,)\\s*algorithm\\s*=\\s*(?:"[^"]*"|[^,\\s]+)/gi) || [];
  if (algorithmParameters.length > 1) throw new Error('Multiple HTTP Signature algorithm parameters are not supported');
  if (algorithmParameters.length !== 1 || !/algorithm\\s*=\\s*"?hs2019"?$/i.test(algorithmParameters[0])) return headers;

  return {
    ...headers,
    signature: signature.replace(algorithmParameters[0], algorithmParameters[0].replace(/hs2019/i, 'rsa-sha256'))
  };
} // ${MARKER}
`;

function replaceOnce(source, search, replacement, label) {
  const first = source.indexOf(search);
  if (first < 0 || source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`Expected exactly one pinned SemApps ${label}`);
  }
  return source.replace(search, replacement);
}

function patchHttpSignatures(source) {
  if (source.includes(MARKER)) {
    const valid = source.includes('function normalizeHs2019RsaSignatureAlgorithm(headers)') &&
      source.includes('headers: normalizeHs2019RsaSignatureAlgorithm(headers)');
    if (!valid) throw new Error('HTTP signature compatibility marker exists without the complete verification contract');
    return { source, changed: false };
  }

  let patched = replaceOnce(
    source,
    "const HttpSignatureService = {",
    `${HELPER}\nconst HttpSignatureService = {`,
    'HTTP signature service declaration'
  );
  patched = replaceOnce(
    patched,
    `        headers\n      });\n\n      const { keyId } = parsedSignature.params;`,
    `        headers: normalizeHs2019RsaSignatureAlgorithm(headers)\n      });\n\n      const { keyId } = parsedSignature.params;`,
    'HTTP signature parser headers'
  );
  return { source: patched, changed: true };
}

function applyPatch(root = path.dirname(require.resolve('@semapps/crypto/package.json'))) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (version !== EXPECTED_VERSION) throw new Error(`Expected @semapps/crypto@${EXPECTED_VERSION}, found ${version}`);

  const file = path.join(root, 'signature/http-signatures.js');
  const result = patchHttpSignatures(fs.readFileSync(file, 'utf8'));
  if (result.changed) fs.writeFileSync(file, result.source);
  process.stdout.write('[ActivityPods] SemApps hs2019 RSA signature verification compatibility applied\n');
}

if (require.main === module) applyPatch();
module.exports = { EXPECTED_VERSION, MARKER, patchHttpSignatures, applyPatch };
