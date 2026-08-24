'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const EXPECTED_VERSION = '1.1.4';
const MARKER = 'activitypods-activitypub-inbox-actor-id-v1';
const PRISTINE_HASH = '99386b74357a63b70b025b210925dc031c614315b147b4f91bc76a911f38fbbc';
const PATCHED_HASH = 'a141c4fc22e34d0cddb323c36a491594649f8072724618d9ffc7e32fcad88057';

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

function patchInbox(source) {
  if (source.includes(MARKER)) {
    requireHash(source, PATCHED_HASH, 'patched ActivityPub inbox source');
    return { source, changed: false };
  }

  requireHash(source, PRISTINE_HASH, 'pristine ActivityPub inbox source');
  let patched = replaceOnce(
    source,
    'const AwaitActivityMixin = require(\'../../../mixins/await-activity\');',
    `const AwaitActivityMixin = require('../../../mixins/await-activity');

function activityActorId(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : null;
  const atId = typeof value['@id'] === 'string' && value['@id'].length > 0 ? value['@id'] : null;
  if (id && atId && id !== atId) return null;
  return id || atId;
} // ${MARKER}`,
    'inbox actor identifier helper'
  );
  patched = replaceOnce(
    patched,
    '      if (activity.actor !== ctx.meta.webId) {',
    '      if (activityActorId(activity.actor) !== ctx.meta.webId) {',
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
module.exports = { EXPECTED_VERSION, MARKER, PRISTINE_HASH, PATCHED_HASH, sha256, patchInbox, applyPatch };
