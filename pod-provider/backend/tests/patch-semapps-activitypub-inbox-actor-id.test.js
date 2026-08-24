const fs = require('fs');
const path = require('path');
const {
  MARKER,
  PATCHED_HASH,
  sha256,
  patchInbox
} = require('../scripts/patch-semapps-activitypub-inbox-actor-id');

const inboxPath = path.join(
  path.dirname(require.resolve('@semapps/activitypub/package.json')),
  'services/activitypub/subservices/inbox.js'
);

describe('SemApps ActivityPub inbox actor identifier compatibility patch', () => {
  test('is wired into local and container dependency installation', () => {
    const packageJson = require('../package.json');
    const dockerfile = fs.readFileSync(path.join(__dirname, '../../docker/backend.dockerfile'), 'utf8');
    expect(packageJson.scripts.postinstall).toContain('node scripts/patch-semapps-activitypub-inbox-actor-id.js');
    expect(dockerfile).toContain(
      'ADD backend/scripts/patch-semapps-activitypub-inbox-actor-id.js /app/backend/scripts/patch-semapps-activitypub-inbox-actor-id.js'
    );
  });

  test('normalizes only standard ActivityStreams entity identifiers before exact signer comparison', () => {
    const installed = fs.readFileSync(inboxPath, 'utf8');
    const result = patchInbox(installed);
    expect(result.changed).toBe(false);
    expect(result.source).toContain(MARKER);
    expect(result.source).toContain("if (activityActorId(activity.actor) !== ctx.meta.webId)");
    expect(result.source).toContain("if (!value || typeof value !== 'object' || Array.isArray(value)) return null;");
    expect(result.source).toContain("if (id && atId && id !== atId) return null;");
    expect(sha256(result.source)).toBe(PATCHED_HASH);
  });
});
