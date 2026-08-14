'use strict';

const fs = require('fs');
const {
  PATCH_MARKER,
  EXPECTED_VERSION,
  findPackageRoot,
  locateOutboxSource,
  patchOutboxSource
} = require('../scripts/patch-semapps-activitypub-local-delivery');

function representativeOutboxSource() {
  return `
const localRecipients = [];
const remoteRecipients = [];
for (const recipientUri of recipients) {
  if (this.isLocalActor(recipientUri)) {
    const account = await ctx.call('auth.account.findByWebId', { webId: recipientUri });
    if (account) {
      localRecipients.push(recipientUri);
    }
  }
}
if (localRecipients.length > 0) {
  this.localPost(localRecipients, activity);
}
async localPost(recipients, activityToPost) {
  await this.broker.call('activitypub.side-effects.processInbox', { activity: activityToPost, recipients });
  for (const recipientUri of recipients) {
    const account = await this.broker.call('auth.account.findByWebId', { webId: recipientUri });
    if (!account) throw new Error(\`No account found with webId \${recipientUri}\`);
    const dataset = this.settings.podProvider ? account.username : undefined;
  }
}
`;
}

function loadInstalledLocalPost() {
  const packageRoot = findPackageRoot();
  const outboxFile = locateOutboxSource(packageRoot);
  delete require.cache[require.resolve(outboxFile)];
  const service = require(outboxFile);
  return service.methods.localPost;
}

function createLocalPostHarness({ account } = {}) {
  const calls = [];
  const emitted = [];
  const broker = {
    call: jest.fn(async (action, params, options) => {
      calls.push({ action, params, options });
      if (action === 'auth.account.findByWebId') return account;
      if (action === 'activitypub.actor.getCollectionUri') return 'https://pod.example/alice/inbox';
      return undefined;
    }),
    emit: jest.fn((event, payload) => emitted.push({ event, payload }))
  };

  return {
    service: {
      broker,
      settings: { podProvider: true },
      logger: { error: jest.fn(), warn: jest.fn() }
    },
    calls,
    emitted
  };
}

describe('APDM Phase 7 SemApps local delivery patch', () => {
  test('published dependency is pinned to the version the patch was reviewed against', () => {
    const packageRoot = findPackageRoot();
    const packageJson = JSON.parse(fs.readFileSync(`${packageRoot}/package.json`, 'utf8'));
    expect(packageJson.version).toBe(EXPECTED_VERSION);
  });

  test('installed outbox artifact is patched during dependency installation', () => {
    const packageRoot = findPackageRoot();
    const outboxFile = locateOutboxSource(packageRoot);
    const source = fs.readFileSync(outboxFile, 'utf8');

    expect(source).toContain(PATCH_MARKER);
    expect(source).toContain('this.localPost(localRecipients, activity, localRecipientContexts);');
    expect(source).toContain('localRecipientContexts.has(recipientUri)');
    expect(source).toContain("ctx.call('auth.account.findByWebId', { webId: recipientUri })");
    expect(source).toContain("this.broker.call('auth.account.findByWebId', { webId: recipientUri })");
  });

  test('normal localPost path reuses resolved dataset with zero duplicate account lookups', async () => {
    const localPost = loadInstalledLocalPost();
    const { service, calls, emitted } = createLocalPostHarness({
      account: { username: 'should-not-be-read' }
    });
    const recipientUri = 'https://pod.example/alice';
    const activity = {
      id: 'https://pod.example/activities/1',
      type: 'Create',
      actor: 'https://pod.example/bob',
      object: 'https://pod.example/objects/1'
    };
    const result = await localPost.call(
      service,
      [recipientUri],
      activity,
      new Map([[recipientUri, { dataset: 'alice-dataset' }]])
    );

    expect(result).toEqual({ success: [recipientUri], failures: [] });
    expect(calls.filter(call => call.action === 'auth.account.findByWebId')).toHaveLength(0);

    const datasetBoundCalls = calls.filter(call =>
      [
        'activitypub.actor.getCollectionUri',
        'activitypub.collection.add',
        'ldp.remote.store',
        'activitypub.activity.attach'
      ].includes(call.action)
    );
    expect(datasetBoundCalls).toHaveLength(4);

    const getInbox = datasetBoundCalls.find(call => call.action === 'activitypub.actor.getCollectionUri');
    const addInbox = datasetBoundCalls.find(call => call.action === 'activitypub.collection.add');
    const remoteStore = datasetBoundCalls.find(call => call.action === 'ldp.remote.store');
    const attach = datasetBoundCalls.find(call => call.action === 'activitypub.activity.attach');

    expect(getInbox.options).toEqual({ meta: { dataset: 'alice-dataset' } });
    expect(addInbox.options).toEqual({ meta: { dataset: 'alice-dataset' } });
    expect(remoteStore.params.dataset).toBe('alice-dataset');
    expect(remoteStore.params.webId).toBe(recipientUri);
    expect(attach.options).toEqual({ meta: { dataset: 'alice-dataset' } });
    expect(emitted).toEqual([
      {
        event: 'activitypub.inbox.received',
        payload: { activity, recipients: [recipientUri], local: true }
      }
    ]);
  });

  test('legacy direct localPost caller keeps original account lookup and dataset behavior', async () => {
    const localPost = loadInstalledLocalPost();
    const { service, calls } = createLocalPostHarness({ account: { username: 'alice-dataset' } });
    const recipientUri = 'https://pod.example/alice';
    const activity = {
      id: 'https://pod.example/activities/2',
      type: 'Like',
      actor: 'https://pod.example/bob',
      object: 'https://remote.example/objects/2'
    };
    const result = await localPost.call(service, [recipientUri], activity);

    expect(result).toEqual({ success: [recipientUri], failures: [] });
    expect(calls.filter(call => call.action === 'auth.account.findByWebId')).toHaveLength(1);
    expect(calls.find(call => call.action === 'ldp.remote.store').params.dataset).toBe('alice-dataset');
    expect(calls.find(call => call.action === 'activitypub.collection.add').options).toEqual({
      meta: { dataset: 'alice-dataset' }
    });
    expect(calls.find(call => call.action === 'activitypub.activity.attach').options).toEqual({
      meta: { dataset: 'alice-dataset' }
    });
  });

  test('normal post-to-localPost source carries dataset context and preserves a legacy fallback', () => {
    const result = patchOutboxSource(representativeOutboxSource());

    expect(result.changed).toBe(true);
    expect(result.source).toContain(PATCH_MARKER);
    expect(result.source).toContain(
      'dataset: this.settings.podProvider ? account.username : undefined'
    );
    expect(result.source).toContain(
      'this.localPost(localRecipients, activity, localRecipientContexts);'
    );
    expect(result.source).toContain('localRecipientContexts.has(recipientUri)');
    expect(result.source).toContain(
      ": await this.broker.call('auth.account.findByWebId', { webId: recipientUri });"
    );

    // The first lookup still validates that the local actor has a real account. The second textual lookup
    // remains only as a backward-compatible branch for direct localPost callers without resolved context.
    expect((result.source.match(/auth\.account\.findByWebId/gu) || []).length).toBe(2);
  });

  test('patch is idempotent', () => {
    const once = patchOutboxSource(representativeOutboxSource());
    const twice = patchOutboxSource(once.source);

    expect(once.changed).toBe(true);
    expect(twice.changed).toBe(false);
    expect(twice.source).toBe(once.source);
  });

  test('fails closed when the SemApps outbox contract drifts', () => {
    expect(() => patchOutboxSource('export default {};')).toThrow(
      'SemApps outbox artifact no longer matches the expected v1.1.4 contract'
    );
  });
});
