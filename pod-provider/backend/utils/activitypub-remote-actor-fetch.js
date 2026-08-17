'use strict';

const http = require('node:http');
const https = require('node:https');
const { lookup: dnsLookup } = require('node:dns/promises');
const { isIP } = require('node:net');
const fetch = require('node-fetch');

const DEFAULT_REMOTE_ACTOR_TIMEOUT_MS = 5000;
const DEFAULT_REMOTE_ACTOR_MAX_BYTES = 1024 * 1024;

class UnsafeActivityPubActorTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeActivityPubActorTargetError';
  }
}

function parseIpv4(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(part => Number.parseInt(part, 10));
  if (octets.some((part, index) => !/^\d+$/u.test(parts[index] || '') || part < 0 || part > 255)) return null;
  return octets;
}

function normalizeHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) return normalized.slice(1, -1);
  return normalized;
}

function isForbiddenActivityPubAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const octets = parseIpv4(address);
    if (!octets) return true;
    const [a = 0, b = 0, c = 0] = octets;
    return (
      a === 0 ||
      a === 10 ||
      (a === 100 && b >= 64 && b <= 127) ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }

  if (version === 6) {
    const normalized = String(address).toLowerCase();
    if (normalized === '::' || normalized === '::1' || normalized.startsWith('::')) return true;
    const parts = normalized.split(':');
    const first = Number.parseInt(parts[0] || '0', 16);
    const second = Number.parseInt(parts[1] || '0', 16);

    // Federation discovery must resolve to globally routable IPv6. Keep the
    // same fail-closed special-purpose policy as the Phase 5 sidecar egress
    // boundary so actor discovery cannot reach a destination delivery cannot.
    if (first < 0x2000 || first > 0x3fff) return true;
    if (first === 0x2001 && second <= 0x01ff) return true;
    if (first === 0x2001 && second === 0x0db8) return true;
    if (first === 0x2002) return true;
    if (first === 0x3ffe || first === 0x3fff) return true;
    return false;
  }

  return true;
}

function isLoopbackAddress(address) {
  if (address === '::1') return true;
  if (isIP(address) !== 4) return false;
  const octets = parseIpv4(address);
  return octets?.[0] === 127;
}

function isExplicitLoopbackHost(hostname) {
  const normalized = normalizeHostname(hostname);
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (isIP(normalized) !== 4) return false;
  return parseIpv4(normalized)?.[0] === 127;
}

function isInteropPrivateAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const octets = parseIpv4(address);
    if (!octets) return false;
    const [a = 0, b = 0] = octets;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (version === 6) {
    const first = Number.parseInt(String(address).toLowerCase().split(':', 1)[0] || '0', 16);
    return first >= 0xfc00 && first <= 0xfdff;
  }
  return false;
}

function loopbackHttpAllowedFromEnvironment() {
  if (process.env.NODE_ENV === 'test') return true;
  return process.env.NODE_ENV === 'development' && process.env.APDM_ALLOW_LOOPBACK_HTTP === 'true';
}

function interopPrivateHostnamesFromEnvironment() {
  const environment = String(process.env.NODE_ENV || '').trim().toLowerCase();
  if (!['test', 'development'].includes(environment)) return undefined;
  const configured = process.env.APDM_INTEROP_PRIVATE_HOSTS;
  if (!configured) return undefined;
  return new Set(configured.split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
}

async function defaultLookup(hostname) {
  const results = await dnsLookup(hostname, { all: true, order: 'verbatim' });
  return results.map(entry => ({ address: entry.address, family: entry.family }));
}

function assertResolvedAddresses(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new UnsafeActivityPubActorTargetError('Remote ActivityPub actor resolved to no addresses');
  }
  for (const entry of addresses) {
    if (!entry || (entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family) {
      throw new UnsafeActivityPubActorTargetError('Remote ActivityPub actor resolver returned an invalid address');
    }
  }
}

async function validateRemoteActorTarget(
  value,
  {
    lookup = defaultLookup,
    allowLoopbackHttp = loopbackHttpAllowedFromEnvironment(),
    interopPrivateHostnames = interopPrivateHostnamesFromEnvironment()
  } = {}
) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeActivityPubActorTargetError('Remote ActivityPub actor target is not a valid URL');
  }

  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new UnsafeActivityPubActorTargetError('Remote ActivityPub actor target must be an exact URL');
  }
  if (url.username || url.password) {
    throw new UnsafeActivityPubActorTargetError('Remote ActivityPub actor target must not contain credentials');
  }
  if (url.hash) {
    throw new UnsafeActivityPubActorTargetError('Remote ActivityPub actor target must not contain a fragment');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UnsafeActivityPubActorTargetError('Remote ActivityPub actor target must use HTTP(S)');
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) throw new UnsafeActivityPubActorTargetError('Remote ActivityPub actor target must contain a hostname');

  const literalFamily = isIP(hostname);
  const addresses = literalFamily === 4 || literalFamily === 6
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname);
  assertResolvedAddresses(addresses);

  const loopbackException =
    allowLoopbackHttp === true &&
    url.protocol === 'http:' &&
    isExplicitLoopbackHost(hostname) &&
    addresses.every(entry => isLoopbackAddress(entry.address));

  const interopPrivateException =
    url.protocol === 'https:' &&
    interopPrivateHostnames?.has(hostname) === true &&
    addresses.every(entry => isInteropPrivateAddress(entry.address));

  const forbidden = addresses.find(entry => isForbiddenActivityPubAddress(entry.address));
  if (forbidden && !loopbackException && !interopPrivateException) {
    throw new UnsafeActivityPubActorTargetError('Remote ActivityPub actor target resolved to a forbidden address');
  }
  if (url.protocol === 'http:' && !loopbackException) {
    throw new UnsafeActivityPubActorTargetError(
      'Plain HTTP remote ActivityPub actor discovery is restricted to explicitly permitted loopback tests'
    );
  }

  return {
    url,
    hostname,
    address: addresses[0].address,
    family: addresses[0].family
  };
}

function createPinnedLookup(target) {
  return (hostname, options, callback) => {
    if (normalizeHostname(hostname) !== target.hostname) {
      callback(new UnsafeActivityPubActorTargetError('Remote ActivityPub actor dispatcher hostname mismatch'));
      return;
    }
    if (options?.all === true) {
      callback(null, [{ address: target.address, family: target.family }]);
      return;
    }
    callback(null, target.address, target.family);
  };
}

function createPinnedAgent(target) {
  const Agent = target.url.protocol === 'https:' ? https.Agent : http.Agent;
  return new Agent({ keepAlive: false, lookup: createPinnedLookup(target) });
}

function normalizePositiveInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

async function fetchRemoteActivityPubActor(
  actorUri,
  {
    fetchImpl = fetch,
    lookup = defaultLookup,
    timeoutMs = DEFAULT_REMOTE_ACTOR_TIMEOUT_MS,
    maxBytes = DEFAULT_REMOTE_ACTOR_MAX_BYTES,
    allowLoopbackHttp,
    interopPrivateHostnames
  } = {}
) {
  const target = await validateRemoteActorTarget(actorUri, {
    lookup,
    ...(allowLoopbackHttp === undefined ? {} : { allowLoopbackHttp }),
    ...(interopPrivateHostnames === undefined ? {} : { interopPrivateHostnames })
  });
  const boundedTimeoutMs = normalizePositiveInteger(timeoutMs, DEFAULT_REMOTE_ACTOR_TIMEOUT_MS, 100, 60000);
  const boundedMaxBytes = normalizePositiveInteger(maxBytes, DEFAULT_REMOTE_ACTOR_MAX_BYTES, 1024, 4 * 1024 * 1024);
  const agent = createPinnedAgent(target);

  try {
    const response = await fetchImpl(target.url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/activity+json, application/ld+json, application/json'
      },
      redirect: 'manual',
      timeout: boundedTimeoutMs,
      size: boundedMaxBytes,
      agent
    });

    if (!response || response.ok !== true) return false;
    const actor = await response.json();
    if (!actor || typeof actor !== 'object' || Array.isArray(actor)) {
      throw new Error('Remote ActivityPub actor response must be a JSON object');
    }
    const returnedActorUri = actor.id || actor['@id'];
    if (typeof returnedActorUri !== 'string' || returnedActorUri !== target.url.toString()) {
      throw new Error('Remote ActivityPub actor response identity does not match the requested actor URI');
    }
    return actor;
  } finally {
    agent.destroy();
  }
}

module.exports = {
  DEFAULT_REMOTE_ACTOR_MAX_BYTES,
  DEFAULT_REMOTE_ACTOR_TIMEOUT_MS,
  UnsafeActivityPubActorTargetError,
  createPinnedLookup,
  fetchRemoteActivityPubActor,
  isForbiddenActivityPubAddress,
  validateRemoteActorTarget
};
