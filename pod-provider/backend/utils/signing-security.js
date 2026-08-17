'use strict';

const crypto = require('crypto');

const MAX_AUTHORIZATION_HEADER_BYTES = 8 * 1024;

function configuredSigningToken(env = process.env) {
  const token = env.ACTIVITYPODS_TOKEN;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

function parseBearerToken(authorization) {
  if (typeof authorization !== 'string' || authorization.length === 0) return null;
  if (Buffer.byteLength(authorization, 'utf8') > MAX_AUTHORIZATION_HEADER_BYTES) return null;

  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(authorization);
  return match ? match[1] : null;
}

function timingSafeSecretEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || actual.length === 0 || expected.length === 0) {
    return false;
  }

  const actualDigest = crypto.createHash('sha256').update(actual, 'utf8').digest();
  const expectedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(actualDigest, expectedDigest);
}

function isDateWithinSkew(dateString, maxClockSkewSeconds, nowMs = Date.now()) {
  if (typeof dateString !== 'string' || dateString.trim().length === 0) return false;

  const maxSkewSeconds = Number(maxClockSkewSeconds);
  if (!Number.isFinite(maxSkewSeconds) || maxSkewSeconds < 0) return false;
  if (!Number.isFinite(nowMs)) return false;

  const parsedMs = Date.parse(dateString);
  if (!Number.isFinite(parsedMs)) return false;

  return Math.abs(nowMs - parsedMs) <= maxSkewSeconds * 1000;
}

module.exports = {
  MAX_AUTHORIZATION_HEADER_BYTES,
  configuredSigningToken,
  isDateWithinSkew,
  parseBearerToken,
  timingSafeSecretEqual
};
