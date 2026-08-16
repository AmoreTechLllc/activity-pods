'use strict';

const fs = require('fs');
const path = require('path');

const fep4adbOutbound = require('../services/core/fep-4adb-outbound');

const backendRoot = path.resolve(__dirname, '..');
const podProviderRoot = path.resolve(backendRoot, '..');

function createOutboundRuntime() {
  return {
    settings: fep4adbOutbound.settings,
    logger: { warn: jest.fn() },
    enrichActorReference: fep4adbOutbound.methods.enrichActorReference,
    processRecipients: fep4adbOutbound.methods.processRecipients
  };
}

describe('APDM Phase 8 runtime environment contracts', () => {
  test('FEP-4adb outbound uses the pinned SemApps actorUri contract without overriding inherited metadata', async () => {
    const actorId = 'https://example.test/alice';
    const ctx = {
      params: {
        activity: { type: 'Create', actor: actorId },
        actorId
      },
      meta: { webId: actorId, dataset: 'alice' },
      call: jest.fn(async (actionName, params) => {
        if (actionName === 'activitypub.actor.get') {
          return { id: actorId, type: 'Person' };
        }
        throw new Error(`Unexpected action ${actionName} with ${JSON.stringify(params)}`);
      })
    };

    const prepared = await fep4adbOutbound.actions.prepareOutboundActivity.call(createOutboundRuntime(), ctx);

    expect(prepared).toEqual({ type: 'Create', actor: actorId });
    expect(ctx.call).toHaveBeenCalledTimes(1);
    expect(ctx.call).toHaveBeenCalledWith('activitypub.actor.get', {
      actorUri: actorId,
      webId: actorId
    });

    // A third ctx.call options argument would replace/alter the normal child-call
    // context. Keeping this a two-argument call lets Moleculer inherit the
    // originating outbox.post metadata, including the Pod owner dataset.
    expect(ctx.call.mock.calls[0]).toHaveLength(2);
    expect(ctx.meta.dataset).toBe('alice');
  });

  test('FEP-4adb source cannot regress to the invalid actor.get id parameter', () => {
    const source = fs.readFileSync(path.join(backendRoot, 'services/core/fep-4adb-outbound.js'), 'utf8');
    expect(source).toContain("ctx.call('activitypub.actor.get', { actorUri: actorId, webId: actorId })");
    expect(source).not.toContain("ctx.call('activitypub.actor.get', { id: actorId })");
  });

  test('Phase 8 routes the ActivityPods rate limiter to Compose Redis instead of localhost', () => {
    const rateLimiterSource = fs.readFileSync(path.join(backendRoot, 'services/core/rate-limiter.service.js'), 'utf8');
    const composeSource = fs.readFileSync(path.join(podProviderRoot, 'docker-compose-phase8.yml'), 'utf8');

    expect(rateLimiterSource).toContain("process.env.SEMAPPS_REDIS_CACHE_URL || 'redis://localhost:6379'");
    expect(composeSource).toContain("SEMAPPS_REDIS_CACHE_URL: 'redis://redis:6379/10'");
  });
});
