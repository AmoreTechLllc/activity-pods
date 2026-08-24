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
    expect(result.source).toContain(
      'const authenticatedActorUri = ctx.meta.httpSignatureActorUri || ctx.meta.webId;'
    );
    expect(result.source).toContain("if (activityActorId(activity.actor) !== authenticatedActorUri)");
    expect(result.source).toContain("if (!value || typeof value !== 'object' || Array.isArray(value)) return null;");
    expect(result.source).toContain("if (id && atId && id !== atId) return null;");
    expect(sha256(result.source)).toBe(PATCHED_HASH);
  });

  test('binds actor authorization to the authenticated principal before awaited broker calls', async () => {
    jest.resetModules();
    const inbox = require(inboxPath);
    const afterActorCheck = new Error('after actor authorization');
    const ctx = {
      params: {
        collectionUri: 'https://local.example/alice/inbox',
        actor: 'https://remote.example/bob'
      },
      meta: { webId: 'https://remote.example/bob' },
      call: jest.fn(async action => {
        if (action === 'ldp.resource.exist') {
          // Moleculer child calls share metadata and may update it while awaited.
          ctx.meta.webId = 'system';
          return true;
        }
        if (action === 'activitypub.collection.getOwner') throw afterActorCheck;
        throw new Error(`Unexpected action ${action}`);
      })
    };

    await expect(inbox.actions.post.call({ settings: { podProvider: true } }, ctx)).rejects.toBe(afterActorCheck);
    expect(ctx.call).toHaveBeenNthCalledWith(2, 'activitypub.collection.getOwner', {
      collectionUri: 'https://local.example/alice/inbox',
      collectionKey: 'inbox'
    });
  });

  test('prefers the request-scoped HTTP signature principal over mutated shared metadata', async () => {
    jest.resetModules();
    const inbox = require(inboxPath);
    const afterActorCheck = new Error('after actor authorization');
    const ctx = {
      params: {
        collectionUri: 'https://local.example/alice/inbox',
        actor: 'https://remote.example/bob'
      },
      meta: {
        webId: 'system',
        httpSignatureActorUri: 'https://remote.example/bob'
      },
      call: jest.fn(async action => {
        if (action === 'ldp.resource.exist') return true;
        if (action === 'activitypub.collection.getOwner') throw afterActorCheck;
        throw new Error(`Unexpected action ${action}`);
      })
    };

    await expect(inbox.actions.post.call({ settings: { podProvider: true } }, ctx)).rejects.toBe(afterActorCheck);
  });

  test('still rejects an activity actor that differs from the captured principal', async () => {
    jest.resetModules();
    const inbox = require(inboxPath);
    const ctx = {
      params: {
        collectionUri: 'https://local.example/alice/inbox',
        actor: 'https://remote.example/mallory'
      },
      meta: { webId: 'https://remote.example/bob' },
      call: jest.fn(async action => {
        if (action !== 'ldp.resource.exist') throw new Error(`Unexpected action ${action}`);
        ctx.meta.webId = 'https://remote.example/mallory';
        return true;
      })
    };

    await expect(inbox.actions.post.call({ settings: { podProvider: true } }, ctx)).rejects.toMatchObject({
      type: 'INVALID_ACTOR'
    });
    expect(ctx.call).toHaveBeenCalledTimes(1);
  });

  test('does not fall back to a mutated webId when a verified signature principal is present', async () => {
    jest.resetModules();
    const inbox = require(inboxPath);
    const ctx = {
      params: {
        collectionUri: 'https://local.example/alice/inbox',
        actor: 'https://remote.example/mallory'
      },
      meta: {
        webId: 'https://remote.example/mallory',
        httpSignatureActorUri: 'https://remote.example/bob'
      },
      call: jest.fn().mockResolvedValue(true)
    };

    await expect(inbox.actions.post.call({ settings: { podProvider: true } }, ctx)).rejects.toMatchObject({
      type: 'INVALID_ACTOR'
    });
    expect(ctx.call).toHaveBeenCalledTimes(1);
  });
});
