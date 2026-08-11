'use strict';

const {
  assertExternalDeliveryConfiguration,
  createOutboxPostHandler,
  createPrivacySafeOutboxContext
} = require('../lib/activitypub-service-with-delivery-strategy');
const {
  containsBlindAudienceFields,
  sanitizeDeliveryActivity
} = require('../utils/activitypub-delivery-plan');

function recipientsFrom(activity) {
  const output = [];
  for (const key of ['to', 'bto', 'cc', 'bcc']) {
    const value = activity?.[key];
    if (value === undefined || value === null) continue;
    output.push(...(Array.isArray(value) ? value : [value]));
  }
  return [...new Set(output)];
}

describe('APDM blind-address privacy boundary', () => {
  test('privacy-safe context strips bto/bcc recursively but restores top-level blind recipients only to getRecipients', async () => {
    const hidden = 'https://remote.example/users/hidden';
    const originalParams = {
      collectionUri: 'https://pods.example/alice/outbox',
      id: 'https://pods.example/alice/activities/blind',
      actor: 'https://pods.example/alice',
      type: 'Create',
      to: [],
      bcc: [hidden],
      object: {
        id: 'https://pods.example/alice/objects/blind',
        type: 'Note',
        content: 'private routing',
        bto: [hidden]
      }
    };
    const calls = [];
    const ctx = {
      params: originalParams,
      async call(action, params) {
        calls.push({ action, params });
        if (action === 'activitypub.activity.getRecipients') {
          return recipientsFrom(params.activity);
        }
        return { ok: true };
      }
    };

    const safeCtx = createPrivacySafeOutboxContext(ctx);
    expect(safeCtx.params).not.toBe(originalParams);
    expect(safeCtx.params.bcc).toBeUndefined();
    expect(safeCtx.params.object.bto).toBeUndefined();
    expect(originalParams.bcc).toEqual([hidden]);
    expect(originalParams.object.bto).toEqual([hidden]);

    const activity = {
      id: originalParams.id,
      actor: originalParams.actor,
      type: 'Create',
      to: []
    };
    const recipients = await safeCtx.call('activitypub.activity.getRecipients', { activity });

    expect(recipients).toEqual([hidden]);
    expect(calls).toHaveLength(2);
    expect(calls[0].params.activity.bcc).toBeUndefined();
    expect(calls[1].params.activity.bcc).toEqual([hidden]);
    expect(calls[1].params.activity.bto).toBeUndefined();
  });

  test('native rollback handler receives sanitized params while blind recipients remain routable', async () => {
    const hidden = 'https://remote.example/users/hidden';
    const ctx = {
      params: {
        collectionUri: 'https://pods.example/alice/outbox',
        id: 'https://pods.example/alice/activities/native-blind',
        actor: 'https://pods.example/alice',
        type: 'Create',
        to: [],
        bto: [hidden],
        object: {
          id: 'https://pods.example/alice/objects/native-blind',
          type: 'Note',
          bcc: [hidden]
        }
      },
      async call(action, params) {
        if (action === 'activitypub.activity.getRecipients') {
          return recipientsFrom(params.activity);
        }
        throw new Error(`Unexpected call ${action}`);
      }
    };

    const nativePost = jest.fn(async safeCtx => {
      expect(safeCtx.params.bto).toBeUndefined();
      expect(safeCtx.params.object.bcc).toBeUndefined();
      const activity = {
        id: safeCtx.params.id,
        actor: safeCtx.params.actor,
        type: safeCtx.params.type,
        to: safeCtx.params.to,
        object: safeCtx.params.object
      };
      const recipients = await safeCtx.call('activitypub.activity.getRecipients', { activity });
      expect(recipients).toEqual([hidden]);
      return activity;
    });

    const handler = createOutboxPostHandler(nativePost);
    const service = { settings: { remoteDeliveryMode: 'native' } };
    const result = await handler.call(service, ctx);

    expect(nativePost).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('"bto"');
    expect(JSON.stringify(result)).not.toContain('"bcc"');
  });

  test('bare Object posts do not invent blind recipients that SemApps object.wrap would not lift', async () => {
    const hidden = 'https://remote.example/users/hidden';
    const calls = [];
    const ctx = {
      params: {
        type: 'Note',
        attributedTo: 'https://pods.example/alice',
        bcc: [hidden],
        content: 'bare object'
      },
      async call(action, params) {
        calls.push({ action, params });
        if (action === 'activitypub.activity.getRecipients') return recipientsFrom(params.activity);
        throw new Error(`Unexpected call ${action}`);
      }
    };

    const safeCtx = createPrivacySafeOutboxContext(ctx);
    expect(safeCtx.params.bcc).toBeUndefined();
    const recipients = await safeCtx.call('activitypub.activity.getRecipients', {
      activity: { type: 'Create', actor: 'https://pods.example/alice', to: [], cc: [] }
    });

    expect(recipients).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test('external mode stores blind routing snapshot before Activity persistence and fails closed if snapshot storage fails', async () => {
    const hidden = 'https://remote.example/users/hidden';
    const finalizedActivity = {
      type: 'Create',
      actor: 'https://pods.example/alice',
      published: '2026-08-11T09:00:00.000Z',
      to: [],
      object: 'https://pods.example/alice/objects/1'
    };
    const calls = [];
    const ctx = {
      params: { ...finalizedActivity, bcc: [hidden] },
      async call(action, params) {
        calls.push({ action, params });
        if (action === 'activitypub-delivery-reconciler.storeBlindRecipientSnapshot') return { stored: true };
        if (action === 'activitypub.activity.post') return 'https://pods.example/alice/activities/1';
        throw new Error(`Unexpected call ${action}`);
      }
    };
    const safeCtx = createPrivacySafeOutboxContext(ctx, { persistBlindSnapshot: true });
    await expect(safeCtx.call('activitypub.activity.post', { resource: finalizedActivity })).resolves.toBe(
      'https://pods.example/alice/activities/1'
    );
    expect(calls.map(call => call.action)).toEqual([
      'activitypub-delivery-reconciler.storeBlindRecipientSnapshot',
      'activitypub.activity.post'
    ]);
    expect(calls[0].params.bcc).toEqual([hidden]);
    expect(calls[0].params.activity).toEqual(finalizedActivity);

    const persistence = jest.fn();
    const failingCtx = {
      params: { ...finalizedActivity, bcc: [hidden] },
      async call(action) {
        if (action === 'activitypub-delivery-reconciler.storeBlindRecipientSnapshot') throw new Error('redis unavailable');
        if (action === 'activitypub.activity.post') return persistence();
        throw new Error(`Unexpected call ${action}`);
      }
    };
    const failingSafeCtx = createPrivacySafeOutboxContext(failingCtx, { persistBlindSnapshot: true });
    await expect(failingSafeCtx.call('activitypub.activity.post', { resource: finalizedActivity }))
      .rejects.toThrow(/redis unavailable/u);
    expect(persistence).not.toHaveBeenCalled();
  });

  test('visible and blind duplicate recipients converge to one recipient identity', async () => {
    const recipient = 'https://remote.example/users/carol';
    const ctx = {
      params: {
        actor: 'https://pods.example/alice',
        type: 'Create',
        to: [recipient],
        bcc: [recipient]
      },
      async call(action, params) {
        if (action === 'activitypub.activity.getRecipients') return recipientsFrom(params.activity);
        throw new Error(`Unexpected call ${action}`);
      }
    };

    const safeCtx = createPrivacySafeOutboxContext(ctx);
    const recipients = await safeCtx.call('activitypub.activity.getRecipients', {
      activity: { actor: ctx.params.actor, to: [recipient] }
    });

    expect(recipients).toEqual([recipient]);
  });

  test('expanded and aliased ActivityStreams blind properties are removed and detected', () => {
    const hidden = 'https://remote.example/users/hidden';
    const expanded = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      [`https://www.w3.org/ns/activitystreams#bcc`]: [hidden]
    };
    expect(containsBlindAudienceFields(expanded)).toBe(true);
    expect(sanitizeDeliveryActivity(expanded)[`https://www.w3.org/ns/activitystreams#bcc`]).toBeUndefined();

    const aliased = {
      '@context': {
        asx: 'https://www.w3.org/ns/activitystreams#',
        secretRecipients: 'asx:bto'
      },
      secretRecipients: [hidden]
    };
    expect(containsBlindAudienceFields(aliased)).toBe(true);
    expect(sanitizeDeliveryActivity(aliased).secretRecipients).toBeUndefined();
  });

  test('unsupported unique audience addressing fails before the native outbox handler can persist anything', async () => {
    const audienceRecipient = 'https://remote.example/users/audience-only';
    const nativePost = jest.fn();
    const handler = createOutboxPostHandler(nativePost);
    const service = { settings: { remoteDeliveryMode: 'native' } };

    await expect(handler.call(service, {
      params: {
        actor: 'https://pods.example/alice',
        type: 'Create',
        to: [],
        audience: [audienceRecipient]
      }
    })).rejects.toThrow(/must also appear in to\/bto\/cc\/bcc/u);

    expect(nativePost).not.toHaveBeenCalled();
  });

  test('audience duplicated in normal addressing is accepted but sender-followers audience fails pre-persistence', () => {
    const actor = 'https://pods.example/alice';
    const recipient = 'https://remote.example/users/carol';

    expect(() => createPrivacySafeOutboxContext({
      params: { type: 'Create', actor, to: [recipient], audience: [recipient] }
    })).not.toThrow();

    expect(() => createPrivacySafeOutboxContext({
      params: { type: 'Create', actor, to: [`${actor}/followers`], audience: [`${actor}/followers`] }
    })).toThrow(/sender-followers audience is unsupported/u);
  });

  test('external handoff config rejects an empty URL fragment and whitespace-normalized URL', () => {
    const base = {
      remoteDeliveryMode: 'external',
      allowExternalDeliveryPreview: true,
      queueServiceUrl: 'redis://queue.example:6379',
      deliveryHandoffToken: 'secret',
      deliveryHandoffTimeoutMs: 5000
    };

    expect(() => assertExternalDeliveryConfiguration({
      ...base,
      deliveryHandoffUrl: 'https://sidecar.example/webhook/outbox#'
    })).toThrow(/URL fragment/u);

    expect(() => assertExternalDeliveryConfiguration({
      ...base,
      deliveryHandoffUrl: ' https://sidecar.example/webhook/outbox'
    })).toThrow(/whitespace padding/u);
  });
});
