'use strict';

const {
  LOCAL_CONTEXT_SYMBOL_KEY,
  LOCAL_DELIVERY_SCOPE_RUNNER_SYMBOL_KEY,
  findPackageRoot,
  locateOutboxSource,
  patchOutboxSource
} = require('../scripts/patch-semapps-activitypub-local-delivery');
const createPhase10Middleware = require('../middlewares/apdm-local-delivery-dataset-exist-memo');

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
  const success = [];
  const failures = [];
  await this.broker.call('activitypub.side-effects.processInbox', { activity: activityToPost, recipients });
  for (const recipientUri of recipients) {
    const account = await this.broker.call('auth.account.findByWebId', { webId: recipientUri });
    if (!account) throw new Error(\`No account found with webId \${recipientUri}\`);
    const dataset = this.settings.podProvider ? account.username : undefined;
    success.push(recipientUri);
  }
      return { success, failures };
    }
`;
}

function loadInstalledLocalPost() {
  const outboxFile = locateOutboxSource(findPackageRoot());
  delete require.cache[require.resolve(outboxFile)];
  return require(outboxFile).methods.localPost;
}

function createLocalPostHarness(account) {
  const calls = [];
  return {
    calls,
    service: {
      settings: { podProvider: true },
      logger: { error: jest.fn(), warn: jest.fn() },
      broker: {
        call: jest.fn(async (action, params, options) => {
          calls.push({ action, params, options });
          if (action === 'auth.account.findByWebId') return account;
          if (action === 'activitypub.actor.getCollectionUri') return 'https://pod.example/alice/inbox';
          return undefined;
        }),
        emit: jest.fn()
      }
    }
  };
}

describe('APDM Phase 7 and Phase 10 adversarial hardening', () => {
  test('Phase 7 rejects marker-preserving drift in the reviewed context-reuse shape', () => {
    const patched = patchOutboxSource(representativeOutboxSource()).source;
    const drifted = patched.replace('localRecipientContexts.get(recipientUri).dataset.length > 0', 'localRecipientContexts.get(recipientUri).dataset.length >= 0');

    expect(drifted).toContain('APDM-P7_LOCAL_RECIPIENT_CONTEXT_REUSE');
    expect(() => patchOutboxSource(drifted)).toThrow(/APDM-P7.*context-aware account lookup/u);
  });

  test('Phase 10 rejects marker-preserving drift in the exact localPost scope dispatch', () => {
    const patched = patchOutboxSource(representativeOutboxSource()).source;
    const drifted = patched.replace(
      "if (typeof phase10LocalDeliveryScopeRunner === 'function')",
      'if (phase10LocalDeliveryScopeRunner)'
    );

    expect(drifted).toContain('APDM-P10_LOCAL_DELIVERY_SCOPE_RUNNER');
    expect(() => patchOutboxSource(drifted)).toThrow(/APDM-P10.*scope dispatch/u);
  });

  test('Phase 7 falls back to the authoritative account lookup when cached dataset context is invalid', async () => {
    const localPost = loadInstalledLocalPost();
    const { service, calls } = createLocalPostHarness({ username: 'fresh-dataset' });
    const recipientUri = 'https://pod.example/alice';
    const activity = {
      id: 'https://pod.example/activities/hardened',
      type: 'Create',
      actor: 'https://pod.example/bob',
      object: 'https://pod.example/objects/hardened'
    };
    Object.defineProperty(activity, Symbol.for(LOCAL_CONTEXT_SYMBOL_KEY), {
      value: new Map([[recipientUri, { dataset: '' }]]),
      configurable: true,
      enumerable: false
    });

    await expect(localPost.call(service, [recipientUri], activity)).resolves.toEqual({
      success: [recipientUri],
      failures: []
    });

    expect(calls.filter(call => call.action === 'auth.account.findByWebId')).toHaveLength(1);
    expect(calls.find(call => call.action === 'ldp.remote.store').params.dataset).toBe('fresh-dataset');
    expect(activity[Symbol.for(LOCAL_CONTEXT_SYMBOL_KEY)]).toBeUndefined();
  });

  test('Phase 10 refuses to overwrite an already-owned process-global scope runner', () => {
    const key = Symbol.for(LOCAL_DELIVERY_SCOPE_RUNNER_SYMBOL_KEY);
    const previous = globalThis[key];
    const foreignRunner = callback => callback();
    globalThis[key] = foreignRunner;

    try {
      expect(() => createPhase10Middleware({ enabled: true })).toThrow(/already installed/u);
      expect(globalThis[key]).toBe(foreignRunner);
    } finally {
      if (previous === undefined) delete globalThis[key];
      else globalThis[key] = previous;
    }
  });

  test('Phase 10 enabled runner validates callbacks and releases only its own global seam', () => {
    const key = Symbol.for(LOCAL_DELIVERY_SCOPE_RUNNER_SYMBOL_KEY);
    const middleware = createPhase10Middleware({ enabled: true });
    const runner = globalThis[key];

    expect(typeof runner).toBe('function');
    expect(() => runner(null)).toThrow(/requires a callback/u);
    middleware.dispose();
    expect(globalThis[key]).toBeUndefined();
  });
});
