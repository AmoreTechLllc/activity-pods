'use strict';

const fs = require('fs');
const path = require('path');
const {
  PATCH_MARKER,
  EXPECTED_VERSION,
  LOCAL_CONTEXT_SYMBOL_KEY,
  findPackageRoot,
  locateOutboxSource,
  patchOutboxSource
} = require('../scripts/patch-semapps-activitypub-local-delivery');
const {
  createActivityPubServiceWithDeliveryStrategy,
  createOutboxPostHandler
} = require('../lib/activitypub-service-with-delivery-strategy');

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

function attachResolvedContext(activity, recipientUri, dataset) {
  Object.defineProperty(activity, Symbol.for(LOCAL_CONTEXT_SYMBOL_KEY), {
    value: new Map([[recipientUri, { dataset }]]),
    configurable: true,
    enumerable: false
  });
}

describe('APDM Phase 7 SemApps local delivery patch', () => {
  test('published dependency is pinned to the version the patch was reviewed against', () => {
    const packageRoot = findPackageRoot();
    const packageJson = JSON.parse(fs.readFileSync(`${packageRoot}/package.json`, 'utf8'));
    expect(packageJson.version).toBe(EXPECTED_VERSION);
  });

  test('production Docker image copies the lifecycle patcher before yarn install', () => {
    const dockerfile = fs.readFileSync(path.resolve(__dirname, '../../docker/backend.dockerfile'), 'utf8');
    const patcherCopy = dockerfile.indexOf('ADD backend/scripts/patch-semapps-activitypub-local-delivery.js');
    const install = dockerfile.indexOf('RUN yarn install && yarn cache clean');

    expect(patcherCopy).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(patcherCopy);
  });

  test('installed outbox artifact is patched without changing the reviewed localPost dispatch shape', () => {
    const packageRoot = findPackageRoot();
    const outboxFile = locateOutboxSource(packageRoot);
    const source = fs.readFileSync(outboxFile, 'utf8');

    expect(source).toContain(PATCH_MARKER);
    expect(source).toContain(`Symbol.for('${LOCAL_CONTEXT_SYMBOL_KEY}')`);
    expect(source).toContain('Object.defineProperty(activity, Symbol.for(');
    expect(source).toContain('this.localPost(localRecipients, activity);');
    expect(source).not.toContain('this.localPost(localRecipients, activity, localRecipientContexts);');
    expect(source).toContain('localRecipientContexts instanceof Map && localRecipientContexts.has(recipientUri)');
    expect(source).toContain('delete activityToPost[localRecipientContextKey]');
    expect(source).toContain("ctx.call('auth.account.findByWebId', { webId: recipientUri })");
    expect(source).toContain("this.broker.call('auth.account.findByWebId', { webId: recipientUri })");
  });

  test('delivery-strategy startup guard accepts the installed Phase 7 outbox shape', () => {
    expect(() => createActivityPubServiceWithDeliveryStrategy()).not.toThrow();
  });

  test('normal localPost path reuses resolved dataset with zero duplicate account lookups and removes private context', async () => {
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
    attachResolvedContext(activity, recipientUri, 'alice-dataset');
    const contextSymbol = Symbol.for(LOCAL_CONTEXT_SYMBOL_KEY);

    expect(Object.getOwnPropertyDescriptor(activity, contextSymbol).enumerable).toBe(false);
    expect(JSON.stringify(activity)).not.toContain(LOCAL_CONTEXT_SYMBOL_KEY);

    const result = await localPost.call(service, [recipientUri], activity);

    expect(result).toEqual({ success: [recipientUri], failures: [] });
    expect(activity[contextSymbol]).toBeUndefined();
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

  test('external delivery interception preserves the same Activity-bound context without a third localPost argument', async () => {
    const localPost = loadInstalledLocalPost();
    const { service: localPostService, calls } = createLocalPostHarness({ account: { username: 'should-not-be-read' } });
    const recipientUri = 'https://pod.example/alice';
    const activity = {
      id: 'https://pod.example/activities/external',
      type: 'Create',
      actor: 'https://pod.example/bob',
      object: 'https://pod.example/objects/external'
    };
    attachResolvedContext(activity, recipientUri, 'alice-dataset');

    const nativeLocalPost = jest.fn((...args) => localPost.call(localPostService, ...args));
    const nativeHandler = async function nativePost() {
      this.localPost([recipientUri], activity);
      return activity;
    };
    const buildDeliveryPlan = jest.fn(async () => ({ intentId: 'phase-7-external-proof' }));
    const enqueueHandoff = jest.fn(async () => 'phase-7-external-proof');
    const wrapped = createOutboxPostHandler(nativeHandler, { buildDeliveryPlan, enqueueHandoff });
    const service = {
      settings: {
        remoteDeliveryMode: 'external',
        allowExternalDeliveryPreview: true,
        podProvider: true,
        queueServiceUrl: 'redis://queue.example:6379',
        deliveryHandoffUrl: 'http://fedify-sidecar:8080/webhook/outbox',
        deliveryHandoffToken: 'secret',
        deliveryHandoffTimeoutMs: 1000
      },
      createJob: jest.fn(),
      localPost: nativeLocalPost,
      broker: { emit: jest.fn() }
    };

    await expect(wrapped.call(service, {})).resolves.toBe(activity);

    expect(nativeLocalPost).toHaveBeenCalledTimes(1);
    expect(nativeLocalPost).toHaveBeenCalledWith([recipientUri], activity);
    expect(calls.filter(call => call.action === 'auth.account.findByWebId')).toHaveLength(0);
    expect(calls.find(call => call.action === 'ldp.remote.store').params.dataset).toBe('alice-dataset');
    expect(activity[Symbol.for(LOCAL_CONTEXT_SYMBOL_KEY)]).toBeUndefined();
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
    expect(result.source).toContain('dataset: this.settings.podProvider ? account.username : undefined');
    expect(result.source).toContain(`Symbol.for('${LOCAL_CONTEXT_SYMBOL_KEY}')`);
    expect(result.source).toContain('enumerable: false');
    expect(result.source).toContain('this.localPost(localRecipients, activity);');
    expect(result.source).toContain('delete activityToPost[localRecipientContextKey]');
    expect(result.source).toContain('localRecipientContexts instanceof Map && localRecipientContexts.has(recipientUri)');
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
