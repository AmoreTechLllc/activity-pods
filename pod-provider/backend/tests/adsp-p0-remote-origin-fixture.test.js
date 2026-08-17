'use strict';

const {
  AS_PUBLIC,
  buildFixtureEvidence,
  createEvidenceLatch,
  REMOTE_DELIVERY_PLANNED_EVENT,
  validateRemoteActorUri
} = require('../scripts/adsp-p0-remote-origin-fixture');
const { computeDeliveryPlanIntentId } = require('../utils/activitypub-delivery-plan');

const ACTIVITY_ID = 'https://pods.example/alice/as/activity/1';
const SENDER_WEB_ID = 'https://pods.example/alice';
const REMOTE_ACTOR_URI = 'http://127.0.0.1:8787/actor/success';

function createDeliveryPlan(overrides = {}) {
  const plan = {
    schema: 'ap.delivery-plan.v1',
    activityId: ACTIVITY_ID,
    actorUri: SENDER_WEB_ID,
    activity: {
      id: ACTIVITY_ID,
      type: 'Create',
      actor: SENDER_WEB_ID,
      to: [REMOTE_ACTOR_URI],
      cc: [AS_PUBLIC],
      object: { type: 'Note', content: 'fixture' }
    },
    localRecipients: [],
    remoteRecipients: [
      {
        actorUri: REMOTE_ACTOR_URI,
        inboxUrl: 'http://127.0.0.1:8787/inbox/success',
        targetDomain: '127.0.0.1'
      }
    ],
    meta: { visibility: 'unlisted', isPublicActivity: true },
    ...overrides
  };
  plan.intentId = Object.prototype.hasOwnProperty.call(overrides, 'intentId')
    ? overrides.intentId
    : computeDeliveryPlanIntentId({
        activityId: plan.activityId,
        actorUri: plan.actorUri,
        localRecipientUris: plan.localRecipients.map(target => target.actorUri),
        remoteRecipientUris: plan.remoteRecipients.map(target => target.actorUri)
      });
  return plan;
}

function createPlannedEvent(overrides = {}) {
  const deliveryPlan = overrides.deliveryPlan || createDeliveryPlan();
  return {
    activity: deliveryPlan.activity,
    deliveryPlan,
    remoteRecipients: deliveryPlan.remoteRecipients.map(target => target.actorUri),
    localRecipients: deliveryPlan.localRecipients.map(target => target.actorUri),
    suppressedNativeRemotePostCount: 1,
    deliveryMode: 'external',
    durableHandoffQueued: true,
    ...overrides
  };
}

function createPostResult(overrides = {}) {
  return {
    id: ACTIVITY_ID,
    actor: SENDER_WEB_ID,
    ...overrides
  };
}

function buildEvidence(overrides = {}) {
  return buildFixtureEvidence({
    postResult: createPostResult(),
    plannedEvent: createPlannedEvent(),
    remoteActorUri: REMOTE_ACTOR_URI,
    senderWebId: SENDER_WEB_ID,
    ...overrides
  });
}

function createFakeBroker() {
  let service;
  return {
    createService(schema) {
      service = schema;
      return schema;
    },
    emitPlanned(params) {
      return service.events[REMOTE_DELIVERY_PLANNED_EVENT].handler({ params });
    }
  };
}

describe('ADSP P0 ActivityPods remote-origin fixture', () => {
  test('accepts credential-free HTTP(S) remote actor URIs and rejects unsafe forms', () => {
    expect(validateRemoteActorUri(REMOTE_ACTOR_URI)).toBe(REMOTE_ACTOR_URI);
    expect(validateRemoteActorUri('https://remote.example/users/alice')).toBe(
      'https://remote.example/users/alice'
    );

    for (const value of [
      '',
      ' https://remote.example/users/alice',
      'ftp://remote.example/users/alice',
      'https://user:pass@remote.example/users/alice',
      'https://remote.example/users/alice#fragment'
    ]) {
      expect(() => validateRemoteActorUri(value)).toThrow(/remote actor URI/u);
    }
  });

  test('does not arm the evidence deadline until the actual outbox boundary', async () => {
    jest.useFakeTimers();
    try {
      const broker = createFakeBroker();
      const senderWebIdRef = { value: SENDER_WEB_ID };
      const marker = 'unique fixture marker';
      const latch = createEvidenceLatch(broker, { senderWebIdRef, marker, timeoutMs: 1000 });

      jest.advanceTimersByTime(10_000);
      await Promise.resolve();

      broker.emitPlanned({
        activity: {
          actor: senderWebIdRef.value,
          object: { content: marker }
        },
        ignoredBeforeArm: true
      });

      latch.arm();
      expect(() => latch.arm()).toThrow(/already armed/u);
      broker.emitPlanned({
        activity: {
          actor: senderWebIdRef.value,
          object: { content: marker }
        },
        capturedAfterArm: true
      });

      await expect(latch.promise).resolves.toEqual(
        expect.objectContaining({ capturedAfterArm: true })
      );
      latch.cancel();
    } finally {
      jest.useRealTimers();
    }
  });

  test('projects only public authority emitted after the real external outbox path durably queues the plan', () => {
    const plan = createDeliveryPlan();
    const result = buildEvidence();

    expect(result).toEqual({
      schema: 'adsp.p0.activitypods-remote-origin.v1',
      activityId: ACTIVITY_ID,
      actorUri: SENDER_WEB_ID,
      activity: plan.activity,
      deliveryPlanSchema: 'ap.delivery-plan.v1',
      deliveryPlanIntentId: plan.intentId,
      remoteActorUri: REMOTE_ACTOR_URI,
      inboxUrl: 'http://127.0.0.1:8787/inbox/success',
      targetDomain: '127.0.0.1',
      visibility: 'unlisted',
      isPublicActivity: true,
      suppressedNativeRemotePostCount: 1,
      durableHandoffQueued: true
    });
  });

  test('fails closed if event mode or durable handoff proof is not authoritative', () => {
    for (const plannedEvent of [
      createPlannedEvent({ deliveryMode: 'native' }),
      createPlannedEvent({ durableHandoffQueued: false })
    ]) {
      expect(() => buildEvidence({ plannedEvent })).toThrow(/external durable-handoff authority/u);
    }
  });

  test('fails closed if the measured Activity would bypass the production RedPanda public event-log path', () => {
    for (const meta of [
      { visibility: 'direct', isPublicActivity: false },
      { visibility: 'direct', isPublicActivity: true },
      { visibility: 'unlisted', isPublicActivity: false }
    ]) {
      const plan = createDeliveryPlan({ meta });
      expect(() => buildEvidence({ plannedEvent: createPlannedEvent({ deliveryPlan: plan }) }))
        .toThrow(/RedPanda event-log path/u);
    }
  });

  test('fails closed on persisted, event, or Delivery Plan Activity identity drift', () => {
    expect(() =>
      buildEvidence({ postResult: createPostResult({ id: `${ACTIVITY_ID}-different` }) })
    ).toThrow(/does not match the persisted outbox Activity/u);

    const plannedEvent = createPlannedEvent();
    plannedEvent.activity = { ...plannedEvent.activity, id: `${ACTIVITY_ID}-different` };
    expect(() => buildEvidence({ plannedEvent })).toThrow(/does not match the persisted outbox Activity/u);
  });

  test('fails closed when persisted, emitted, or planned actor authority differs from the genuine sender', () => {
    expect(() =>
      buildEvidence({ postResult: createPostResult({ actor: 'https://pods.example/mallory' }) })
    ).toThrow(/does not match the genuine sender authority/u);

    const eventActorDrift = createPlannedEvent();
    eventActorDrift.activity = { ...eventActorDrift.activity, actor: 'https://pods.example/mallory' };
    expect(() => buildEvidence({ plannedEvent: eventActorDrift })).toThrow(/genuine sender authority/u);

    const planActorDrift = createDeliveryPlan({
      actorUri: 'https://pods.example/mallory',
      activity: {
        ...createDeliveryPlan().activity,
        actor: 'https://pods.example/mallory'
      }
    });
    expect(() => buildEvidence({ plannedEvent: createPlannedEvent({ deliveryPlan: planActorDrift }) }))
      .toThrow(/genuine sender authority/u);
  });

  test('fails closed on remote-recipient ambiguity or requested-actor drift', () => {
    const ambiguous = createDeliveryPlan({
      remoteRecipients: [
        createDeliveryPlan().remoteRecipients[0],
        {
          actorUri: 'https://other.example/bob',
          inboxUrl: 'https://other.example/bob/inbox',
          targetDomain: 'other.example'
        }
      ]
    });
    expect(() =>
      buildEvidence({ plannedEvent: createPlannedEvent({ deliveryPlan: ambiguous }) })
    ).toThrow(/exactly one authoritative remote recipient/u);

    expect(() =>
      buildEvidence({ remoteActorUri: 'http://127.0.0.1:8787/actor/transient' })
    ).toThrow(/does not match requested actor/u);
  });

  test('fails closed if local-recipient or emitted-recipient evidence contaminates the controlled case', () => {
    const localTarget = {
      actorUri: 'https://pods.example/bob',
      dataset: 'bob',
      inboxUri: 'https://pods.example/bob/inbox'
    };
    const contaminatedPlan = createDeliveryPlan({
      localRecipients: [localTarget]
    });
    expect(() =>
      buildEvidence({ plannedEvent: createPlannedEvent({ deliveryPlan: contaminatedPlan }) })
    ).toThrow(/authoritative local recipients/u);

    expect(() =>
      buildEvidence({ plannedEvent: createPlannedEvent({ localRecipients: ['https://pods.example/bob'] }) })
    ).toThrow(/Emitted local recipient evidence/u);

    expect(() =>
      buildEvidence({ plannedEvent: createPlannedEvent({ remoteRecipients: ['https://other.example/bob'] }) })
    ).toThrow(/Emitted remote recipient evidence/u);
  });

  test('fails closed unless exactly one native remotePost job was suppressed', () => {
    for (const count of [0, 2, undefined]) {
      expect(() =>
        buildEvidence({ plannedEvent: createPlannedEvent({ suppressedNativeRemotePostCount: count }) })
      ).toThrow(/exactly one suppressed native remotePost job/u);
    }
  });

  test('uses the real Delivery Plan validator, including canonical intent and target-domain semantics', () => {
    const badIntent = createDeliveryPlan({ intentId: 'intent-123' });
    expect(() => buildEvidence({ plannedEvent: createPlannedEvent({ deliveryPlan: badIntent }) }))
      .toThrow(/valid authoritative ap\.delivery-plan\.v1/u);

    const badDomain = createDeliveryPlan();
    badDomain.remoteRecipients = [{ ...badDomain.remoteRecipients[0], targetDomain: '127.0.0.1:8787' }];
    expect(() => buildEvidence({ plannedEvent: createPlannedEvent({ deliveryPlan: badDomain }) }))
      .toThrow(/valid authoritative ap\.delivery-plan\.v1/u);
  });
});
