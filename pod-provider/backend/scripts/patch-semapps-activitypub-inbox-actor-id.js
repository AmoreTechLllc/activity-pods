'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const EXPECTED_VERSION = '1.1.4';
const MARKER = 'activitypods-activitypub-inbox-actor-id-v6';
const RAW_ACTOR_UNSUPPORTED_MARKER = 'activitypods-activitypub-inbox-actor-id-v5';
const SINGLETON_UNSUPPORTED_MARKER = 'activitypods-activitypub-inbox-actor-id-v4';
const PREVIOUS_MARKER = 'activitypods-activitypub-inbox-actor-id-v3';
const OLDER_MARKER = 'activitypods-activitypub-inbox-actor-id-v2';
const LEGACY_MARKER = 'activitypods-activitypub-inbox-actor-id-v1';
const PRISTINE_HASH = '99386b74357a63b70b025b210925dc031c614315b147b4f91bc76a911f38fbbc';
const LEGACY_PATCHED_HASH = 'a141c4fc22e34d0cddb323c36a491594649f8072724618d9ffc7e32fcad88057';
const OLDER_PATCHED_HASH = '8c349b9d18ea11f996e22860025dd9a78f01b75bf66cb46745062cf6203f10b3';
const PREVIOUS_PATCHED_HASH = 'fef56adcc165c4d990e255afdab93538a2d96363bc12d6aba95b673bf6136290';
const SINGLETON_UNSUPPORTED_PATCHED_HASH = '8d40d956a047174c4a15b2103a90a18afaad2a03cbae066717a29d60f460e310';
const RAW_ACTOR_UNSUPPORTED_PATCHED_HASH = '62742f613905853192ed8bf16268392b159dfa7d4b60aebc27d28921d89d9a17';
const PATCHED_HASH = 'bcb616f782453ebea7ee5955185495b8b863bbdfd7a3316a9ec78d47b5aa66b6';

function sha256(source) {
  return createHash('sha256').update(source).digest('hex');
}

function requireHash(source, expected, label) {
  const actual = sha256(source);
  if (expected && actual !== expected) {
    throw new Error(`Pinned SemApps ${label} hash mismatch: expected ${expected}, found ${actual}`);
  }
}

function replaceOnce(source, search, replacement, label) {
  const first = source.indexOf(search);
  if (first < 0 || source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`Expected exactly one pinned SemApps ${label}`);
  }
  return source.replace(search, replacement);
}

function addSingletonActorArraySupport(source) {
  return replaceOnce(
    source,
    `  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;`,
    `  if (Array.isArray(value)) return value.length === 1 ? activityActorId(value[0]) : null;
  if (!value || typeof value !== 'object') return null;`,
    'singleton actor array normalization'
  );
}

function addRawActorBinding(source) {
  let upgraded = replaceOnce(source, RAW_ACTOR_UNSUPPORTED_MARKER, MARKER, 'raw-actor-unsupported marker');
  upgraded = replaceOnce(
    upgraded,
    `  return id || atId;
} // ${MARKER}`,
    `  return id || atId;
}

function rawActivityActorId(rawBody) {
  if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) return null;
  try {
    const parsed = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return activityActorId(parsed.actor);
  } catch {
    return null;
  }
} // ${MARKER}`,
    'signed raw activity actor helper'
  );
  upgraded = replaceOnce(
    upgraded,
    `      const activityActorUri = activityActorId(activity.actor);
      if (activityActorUri !== authenticatedActorUri) {
        this.logger.warn('Rejected ActivityPub inbox actor/signature mismatch', { authenticatedActorUri, activityActorUri });
        throw new E.UnAuthorizedError('INVALID_ACTOR', 'Activity actor is not the same as the posting actor');
      }`,
    `      const parsedActivityActorUri = activityActorId(activity.actor);
      const rawActivityActorUri = rawActivityActorId(ctx.meta.rawBody);
      if (parsedActivityActorUri && rawActivityActorUri && parsedActivityActorUri !== rawActivityActorUri) {
        this.logger.warn('Rejected ActivityPub inbox raw/action actor mismatch', {
          authenticatedActorUri,
          parsedActivityActorUri,
          rawActivityActorUri
        });
        throw new E.UnAuthorizedError('INVALID_ACTOR', 'Activity actor changed during request processing');
      }
      const activityActorUri = parsedActivityActorUri || rawActivityActorUri;
      if (activityActorUri !== authenticatedActorUri) {
        this.logger.warn('Rejected ActivityPub inbox actor/signature mismatch', { authenticatedActorUri, activityActorUri });
        throw new E.UnAuthorizedError('INVALID_ACTOR', 'Activity actor is not the same as the posting actor');
      }
      if (!parsedActivityActorUri) activity.actor = rawActivityActorUri;`,
    'signed raw/action actor binding'
  );
  return upgraded;
}

function patchInbox(source) {
  if (source.includes(MARKER)) {
    requireHash(source, PATCHED_HASH, 'patched ActivityPub inbox source');
    return { source, changed: false };
  }

  if (source.includes(RAW_ACTOR_UNSUPPORTED_MARKER)) {
    requireHash(source, RAW_ACTOR_UNSUPPORTED_PATCHED_HASH, 'raw-actor-unsupported patched ActivityPub inbox source');
    const upgraded = addRawActorBinding(source);
    requireHash(upgraded, PATCHED_HASH, 'patched ActivityPub inbox source');
    return { source: upgraded, changed: true };
  }

  if (source.includes(SINGLETON_UNSUPPORTED_MARKER)) {
    requireHash(source, SINGLETON_UNSUPPORTED_PATCHED_HASH, 'singleton-unsupported patched ActivityPub inbox source');
    let upgraded = replaceOnce(
      source,
      SINGLETON_UNSUPPORTED_MARKER,
      RAW_ACTOR_UNSUPPORTED_MARKER,
      'singleton-unsupported inbox actor identifier marker'
    );
    upgraded = addSingletonActorArraySupport(upgraded);
    upgraded = addRawActorBinding(upgraded);
    requireHash(upgraded, PATCHED_HASH, 'patched ActivityPub inbox source');
    return { source: upgraded, changed: true };
  }

  if (source.includes(PREVIOUS_MARKER)) {
    requireHash(source, PREVIOUS_PATCHED_HASH, 'previous patched ActivityPub inbox source');
    let upgraded = replaceOnce(source, PREVIOUS_MARKER, RAW_ACTOR_UNSUPPORTED_MARKER, 'previous inbox actor identifier marker');
    upgraded = replaceOnce(
      upgraded,
      `      if (activityActorId(activity.actor) !== authenticatedActorUri) {
        throw new E.UnAuthorizedError('INVALID_ACTOR', 'Activity actor is not the same as the posting actor');
      }`,
      `      const activityActorUri = activityActorId(activity.actor);
      if (activityActorUri !== authenticatedActorUri) {
        this.logger.warn('Rejected ActivityPub inbox actor/signature mismatch', { authenticatedActorUri, activityActorUri });
        throw new E.UnAuthorizedError('INVALID_ACTOR', 'Activity actor is not the same as the posting actor');
      }`,
      'actor mismatch diagnostics'
    );
    upgraded = addSingletonActorArraySupport(upgraded);
    upgraded = addRawActorBinding(upgraded);
    requireHash(upgraded, PATCHED_HASH, 'patched ActivityPub inbox source');
    return { source: upgraded, changed: true };
  }

  if (source.includes(OLDER_MARKER)) {
    requireHash(source, OLDER_PATCHED_HASH, 'older patched ActivityPub inbox source');
    let upgraded = replaceOnce(source, OLDER_MARKER, RAW_ACTOR_UNSUPPORTED_MARKER, 'older inbox actor identifier marker');
    upgraded = replaceOnce(
      upgraded,
      '      const authenticatedActorUri = ctx.meta.webId;',
      '      const authenticatedActorUri = ctx.meta.httpSignatureActorUri || ctx.meta.webId;',
      'request-scoped HTTP signature principal'
    );
    upgraded = replaceOnce(
      upgraded,
      `      if (activityActorId(activity.actor) !== authenticatedActorUri) {
        throw new E.UnAuthorizedError('INVALID_ACTOR', 'Activity actor is not the same as the posting actor');
      }`,
      `      const activityActorUri = activityActorId(activity.actor);
      if (activityActorUri !== authenticatedActorUri) {
        this.logger.warn('Rejected ActivityPub inbox actor/signature mismatch', { authenticatedActorUri, activityActorUri });
        throw new E.UnAuthorizedError('INVALID_ACTOR', 'Activity actor is not the same as the posting actor');
      }`,
      'actor mismatch diagnostics'
    );
    upgraded = addSingletonActorArraySupport(upgraded);
    upgraded = addRawActorBinding(upgraded);
    requireHash(upgraded, PATCHED_HASH, 'patched ActivityPub inbox source');
    return { source: upgraded, changed: true };
  }

  if (source.includes(LEGACY_MARKER)) {
    requireHash(source, LEGACY_PATCHED_HASH, 'legacy patched ActivityPub inbox source');
    let upgraded = replaceOnce(source, LEGACY_MARKER, RAW_ACTOR_UNSUPPORTED_MARKER, 'legacy inbox actor identifier marker');
    upgraded = replaceOnce(
      upgraded,
      '      const { collectionUri, ...activity } = ctx.params;',
      `      const { collectionUri, ...activity } = ctx.params;
      const authenticatedActorUri = ctx.meta.httpSignatureActorUri || ctx.meta.webId;`,
      'authenticated actor snapshot'
    );
    upgraded = replaceOnce(
      upgraded,
      '      if (activityActorId(activity.actor) !== ctx.meta.webId) {',
      `      const activityActorUri = activityActorId(activity.actor);
      if (activityActorUri !== authenticatedActorUri) {
        this.logger.warn('Rejected ActivityPub inbox actor/signature mismatch', { authenticatedActorUri, activityActorUri });`,
      'immutable authenticated actor comparison'
    );
    upgraded = addSingletonActorArraySupport(upgraded);
    upgraded = addRawActorBinding(upgraded);
    requireHash(upgraded, PATCHED_HASH, 'patched ActivityPub inbox source');
    return { source: upgraded, changed: true };
  }

  requireHash(source, PRISTINE_HASH, 'pristine ActivityPub inbox source');
  let patched = replaceOnce(
    source,
    'const AwaitActivityMixin = require(\'../../../mixins/await-activity\');',
    `const AwaitActivityMixin = require('../../../mixins/await-activity');

function activityActorId(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value)) return value.length === 1 ? activityActorId(value[0]) : null;
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : null;
  const atId = typeof value['@id'] === 'string' && value['@id'].length > 0 ? value['@id'] : null;
  if (id && atId && id !== atId) return null;
  return id || atId;
}

function rawActivityActorId(rawBody) {
  if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) return null;
  try {
    const parsed = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return activityActorId(parsed.actor);
  } catch {
    return null;
  }
} // ${MARKER}`,
    'inbox actor identifier helper'
  );
  patched = replaceOnce(
    patched,
    '      const { collectionUri, ...activity } = ctx.params;',
    `      const { collectionUri, ...activity } = ctx.params;
      const authenticatedActorUri = ctx.meta.httpSignatureActorUri || ctx.meta.webId;`,
    'authenticated actor snapshot'
  );
  patched = replaceOnce(
    patched,
    `      if (activity.actor !== ctx.meta.webId) {
        throw new E.UnAuthorizedError('INVALID_ACTOR', 'Activity actor is not the same as the posting actor');
      }`,
    `      const parsedActivityActorUri = activityActorId(activity.actor);
      const rawActivityActorUri = rawActivityActorId(ctx.meta.rawBody);
      if (parsedActivityActorUri && rawActivityActorUri && parsedActivityActorUri !== rawActivityActorUri) {
        this.logger.warn('Rejected ActivityPub inbox raw/action actor mismatch', {
          authenticatedActorUri,
          parsedActivityActorUri,
          rawActivityActorUri
        });
        throw new E.UnAuthorizedError('INVALID_ACTOR', 'Activity actor changed during request processing');
      }
      const activityActorUri = parsedActivityActorUri || rawActivityActorUri;
      if (activityActorUri !== authenticatedActorUri) {
        this.logger.warn('Rejected ActivityPub inbox actor/signature mismatch', { authenticatedActorUri, activityActorUri });
        throw new E.UnAuthorizedError('INVALID_ACTOR', 'Activity actor is not the same as the posting actor');
      }
      if (!parsedActivityActorUri) activity.actor = rawActivityActorUri;`,
    'inbox authenticated actor comparison'
  );
  requireHash(patched, PATCHED_HASH, 'patched ActivityPub inbox source');
  return { source: patched, changed: true };
}

function applyPatch(root = path.dirname(require.resolve('@semapps/activitypub/package.json'))) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (version !== EXPECTED_VERSION) throw new Error(`Expected @semapps/activitypub@${EXPECTED_VERSION}, found ${version}`);
  const file = path.join(root, 'services/activitypub/subservices/inbox.js');
  const result = patchInbox(fs.readFileSync(file, 'utf8'));
  if (result.changed) fs.writeFileSync(file, result.source);
  process.stdout.write('[ActivityPods] SemApps ActivityPub inbox actor identifier compatibility applied\n');
}

if (require.main === module) applyPatch();
module.exports = {
  EXPECTED_VERSION,
  MARKER,
  RAW_ACTOR_UNSUPPORTED_MARKER,
  SINGLETON_UNSUPPORTED_MARKER,
  PREVIOUS_MARKER,
  OLDER_MARKER,
  LEGACY_MARKER,
  PRISTINE_HASH,
  RAW_ACTOR_UNSUPPORTED_PATCHED_HASH,
  SINGLETON_UNSUPPORTED_PATCHED_HASH,
  LEGACY_PATCHED_HASH,
  OLDER_PATCHED_HASH,
  PREVIOUS_PATCHED_HASH,
  PATCHED_HASH,
  sha256,
  patchInbox,
  applyPatch
};
