'use strict';

const fs = require('fs');
const path = require('path');
const {
  findPackageRoot,
  locateOutboxSource,
  patchOutboxSource
} = require('../scripts/patch-semapps-activitypub-local-delivery');
const {
  PHASE9_CONCURRENCY_MARKER,
  LOCAL_DELIVERY_CONCURRENCY_ENV,
  DEFAULT_LOCAL_DELIVERY_CONCURRENCY,
  MAX_LOCAL_DELIVERY_CONCURRENCY,
  resolveLocalDeliveryConcurrency,
  patchPhase9OutboxSource
} = require('../scripts/patch-semapps-activitypub-local-delivery-phase9');

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

      try {
        await this.broker.call('activitypub.side-effects.processInbox', { activity: activityToPost, recipients });
      } catch (e) {}

      for (const recipientUri of recipients) {
        try {
          const account = await this.broker.call('auth.account.findByWebId', { webId: recipientUri });
          if (!account) throw new Error(\`No account found with webId \${recipientUri}\`);
          const dataset = this.settings.podProvider ? account.username : undefined;
          success.push(recipientUri);
        } catch (e) {
          this.logger.warn(\`Error when posting activity to local actor \${recipientUri}: \${e.message}\`);
          failures.push(recipientUri);
        }
      }

      this.broker.emit('activitypub.inbox.received', { activity: activityToPost, recipients, local: true });
      return { success, failures };
    }
`;
}

function loadInstalledLocalPost() {
  const outboxFile = locateOutboxSource(findPackageRoot());
  delete require.cache[require.resolve(outboxFile)];
  return require(outboxFile).methods.localPost;
}

function createActivity(id) {
  return {
    id: `https://pod.example/activities/${id}`,
    type: 'Create',
    actor: 'https://pod.example/sender',
    object: `https://pod.example/objects/${id}`
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('APDM Phase 9 bounded local delivery concurrency', () => {
  const originalConcurrency = process.env[LOCAL_DELIVERY_CONCURRENCY_ENV];

  afterEach(() => {
    if (originalConcurrency === undefined) delete process.env[LOCAL_DELIVERY_CONCURRENCY_ENV];
    else process.env[LOCAL_DELIVERY_CONCURRENCY_ENV] = originalConcurrency;
  });

  test('configuration defaults safely and clamps the hard ceiling', () => {
    for (const value of [undefined, '', '0', '-1', '4x', '999999999999999999999999999999999']) {
      expect(resolveLocalDeliveryConcurrency(value)).toBe(DEFAULT_LOCAL_DELIVERY_CONCURRENCY);
    }
    expect(resolveLocalDeliveryConcurrency('4')).toBe(4);
    expect(resolveLocalDeliveryConcurrency(String(MAX_LOCAL_DELIVERY_CONCURRENCY + 1000))).toBe(
      MAX_LOCAL_DELIVERY_CONCURRENCY
    );
  });

  test('patch layers on reviewed Phase 7/8 source, preserves bounded workers and is idempotent', () => {
    const predecessor = patchOutboxSource(representativeOutboxSource());
    const once = patchPhase9OutboxSource(predecessor.source);
    const twice = patchPhase9OutboxSource(once.source);

    expect(once.changed).toBe(true);
    expect(once.source).toContain(PHASE9_CONCURRENCY_MARKER);
    expect(once.source).toContain('const workerCount = Math.min(localDeliveryConcurrency, recipients.length);');
    expect(once.source).toContain('await Promise.all(workers);');
    expect(once.source).not.toContain('Promise.all(recipients.map');
    expect(once.source).toContain('successResults[recipientIndex] = recipientUri;');
    expect(once.source).toContain('failureResults[recipientIndex] = recipientUri;');
    expect(twice).toEqual({ source: once.source, changed: false });
  });

  test('production image supplies both patchers before dependency installation', () => {
    const dockerfile = fs.readFileSync(path.resolve(__dirname, '../../docker/backend.dockerfile'), 'utf8');
    const p7 = dockerfile.indexOf('ADD backend/scripts/patch-semapps-activitypub-local-delivery.js');
    const p9 = dockerfile.indexOf('ADD backend/scripts/patch-semapps-activitypub-local-delivery-phase9.js');
    const install = dockerfile.indexOf('RUN yarn install && yarn cache clean');
    expect(p7).toBeGreaterThan(-1);
    expect(p9).toBeGreaterThan(p7);
    expect(install).toBeGreaterThan(p9);
  });

  test('installed pinned SemApps artifact contains the Phase 9 marker', () => {
    const source = fs.readFileSync(locateOutboxSource(findPackageRoot()), 'utf8');
    expect(source).toContain(PHASE9_CONCURRENCY_MARKER);
  });

  test('configured concurrency is a real in-flight ceiling', async () => {
    process.env[LOCAL_DELIVERY_CONCURRENCY_ENV] = '3';
    const localPost = loadInstalledLocalPost();
    const recipients = Array.from({ length: 12 }, (_, i) => `https://pod.example/user-${i}`);
    let active = 0;
    let maximum = 0;

    const service = {
      settings: { podProvider: true },
      logger: { error: jest.fn(), warn: jest.fn() },
      broker: {
        call: jest.fn(async (action, params) => {
          if (action === 'activitypub.side-effects.processInbox') return;
          if (action === 'auth.account.findByWebId') return { username: params.webId.split('/').pop() };
          if (action === 'activitypub.actor.getCollectionUri') {
            active += 1;
            maximum = Math.max(maximum, active);
            await delay(8);
            active -= 1;
            return `${params.actorUri}/inbox`;
          }
          return undefined;
        }),
        emit: jest.fn()
      }
    };

    await expect(localPost.call(service, recipients, createActivity('bounded'))).resolves.toEqual({
      success: recipients,
      failures: []
    });
    expect(maximum).toBe(3);
  });

  test('default/explicit concurrency one preserves serial execution', async () => {
    delete process.env[LOCAL_DELIVERY_CONCURRENCY_ENV];
    const localPost = loadInstalledLocalPost();
    const recipients = ['https://pod.example/a', 'https://pod.example/b', 'https://pod.example/c'];
    let active = 0;
    let maximum = 0;
    const starts = [];

    const service = {
      settings: { podProvider: true },
      logger: { error: jest.fn(), warn: jest.fn() },
      broker: {
        call: jest.fn(async (action, params) => {
          if (action === 'activitypub.side-effects.processInbox') return;
          if (action === 'auth.account.findByWebId') return { username: params.webId.split('/').pop() };
          if (action === 'activitypub.actor.getCollectionUri') {
            active += 1;
            maximum = Math.max(maximum, active);
            starts.push(params.actorUri);
            await delay(2);
            active -= 1;
            return `${params.actorUri}/inbox`;
          }
          return undefined;
        }),
        emit: jest.fn()
      }
    };

    await expect(localPost.call(service, recipients, createActivity('serial'))).resolves.toEqual({
      success: recipients,
      failures: []
    });
    expect(maximum).toBe(1);
    expect(starts).toEqual(recipients);
  });

  test('out-of-order completion and failures still return deterministic recipient-order results', async () => {
    process.env[LOCAL_DELIVERY_CONCURRENCY_ENV] = '4';
    const localPost = loadInstalledLocalPost();
    const recipients = [
      'https://pod.example/slow-success',
      'https://pod.example/fast-failure',
      'https://pod.example/fast-success',
      'https://pod.example/slow-failure'
    ];

    const service = {
      settings: { podProvider: true },
      logger: { error: jest.fn(), warn: jest.fn() },
      broker: {
        call: jest.fn(async (action, params) => {
          if (action === 'activitypub.side-effects.processInbox') return;
          if (action === 'auth.account.findByWebId') return { username: params.webId.split('/').pop() };
          if (action === 'activitypub.actor.getCollectionUri') {
            await delay(params.actorUri.includes('slow') ? 12 : 1);
            if (params.actorUri.includes('failure')) throw new Error('injected recipient failure');
            return `${params.actorUri}/inbox`;
          }
          return undefined;
        }),
        emit: jest.fn()
      }
    };

    await expect(localPost.call(service, recipients, createActivity('ordered'))).resolves.toEqual({
      success: ['https://pod.example/slow-success', 'https://pod.example/fast-success'],
      failures: ['https://pod.example/fast-failure', 'https://pod.example/slow-failure']
    });
    expect(service.logger.warn).toHaveBeenCalledTimes(2);
  });
});
