'use strict';

function normalizeProviderPath(pathname) {
  const normalized = pathname.replace(/\/+$/u, '');
  return normalized.length > 0 ? normalized : '/';
}

function parseProviderBaseUrl(baseUri) {
  if (typeof baseUri !== 'string' || baseUri.length === 0) {
    throw new Error('ActivityPub provider URI matcher requires a configured base URI');
  }

  let parsed;
  try {
    parsed = new URL(baseUri);
  } catch {
    throw new Error('ActivityPub provider base URI must be an absolute URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('ActivityPub provider base URI must use HTTP or HTTPS');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('ActivityPub provider base URI must not contain credentials, query, or fragment');
  }

  return {
    origin: parsed.origin,
    path: normalizeProviderPath(parsed.pathname)
  };
}

function createProviderUriMatcher(baseUri) {
  const provider = parseProviderBaseUrl(baseUri);

  return value => {
    if (typeof value !== 'string' || value.length === 0) return false;

    let candidate;
    try {
      candidate = new URL(value);
    } catch {
      return false;
    }

    if (!['http:', 'https:'].includes(candidate.protocol)) return false;
    if (candidate.username || candidate.password) return false;
    if (candidate.origin !== provider.origin) return false;

    if (provider.path === '/') return true;
    return candidate.pathname === provider.path || candidate.pathname.startsWith(`${provider.path}/`);
  };
}

function isProviderOwnedUri(value, baseUri) {
  return createProviderUriMatcher(baseUri)(value);
}

module.exports = {
  createProviderUriMatcher,
  isProviderOwnedUri,
  normalizeProviderPath,
  parseProviderBaseUrl
};
