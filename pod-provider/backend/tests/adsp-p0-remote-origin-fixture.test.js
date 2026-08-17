'use strict';

const {
  buildFixtureEvidence,
  createEvidenceLatch,
  REMOTE_DELIVERY_PLANNED_EVENT,
  validateRemoteActorUri
} = require('../scripts/adsp-p0-remote-origin-fixture');

function createDeliveryPlan(overrides = {}) {
  return {
    schema: 'ap.delivery-plan.v1',
    intentId: 'intent-123',
    activityId: 'https://pods.example/alice/as/activity/1',
    actorUri: 'https://pods.example/alice',
    activity: {
      id: 'https://pods.example/alice/as/activity/1',
      type: 'Create',
      actor: 'https://pods.example/alice',
      object: { type: 'Note', content: 'fixture' }
    },
    localRecipients: [],
    remoteRecipients: [
      {
        actorUri: 'http://127.0.0.1:8787/actor/success',
        inboxUrl: 'http://127.0.0.1:8787/inbox/success',
        targetDomain: '127.0.0.1:8787'
      }
    ],
    meta: { visibility: 'direct', isPublicActivity: false },
    ...overrides
  };
}

function createPlannedEvent(overrides = {}) {
  return {
    activity: createDeliveryPlan().activity,
    deliveryPlan: createDeliveryPlan(),
    remoteRecipients: ['http://127.0.0.1:8787/actor/success'],
    localRecipients: [],
    suppressedNativeRemotePostCount: 1,
    deliveryMode: 'external',
    durableHandoffQueued: true,
    ...overrides
  };
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
    expect(validateRemoteActorUri('http://127.0.0.1:8787/actor/success')).toBe(
      'http://127.0.0.1:8787/actor/success'
    );
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
      const senderWebIdRef = { value: 'https://pods.example/alice' };
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

  test('projects only authority emitted after the real external outbox path durably queues the plan', () => {
    const result = buildFixtureEvidence({
      postResult: { id: 'https://pods.example/alice/as/activity/1' },
      plannedEvent: createPlannedEvent(),
      remoteActorUri: 'http://127.0.0.1:8787/actor/success'
    });

    expect(result).toEqual({
      schema: 'adsp.p0.activitypods-remote-origin.v1',
      activityId: 'https://pods.example/alice/as/activity/1',
      actorUri: 'https://pods.example/alice',
      activity: createDeliveryPlan().activity,
      deliveryPlanSchema: 'ap.delivery-plan.v1',
      deliveryPlanIntentId: 'intent-123',
      remoteActorUri: 'http://127.0.0.1:8787/actor/success',
      inboxUrl: 'http://127.0.0.1:8787/inbox/success',
      targetDomain: '127.0.0.1:8787',
      suppressedNativeRemotePostCount: 1,
      durableHandoffQueued: true
    });
  });

  test('fails closed if event mode or durable handoff proof is not authoritative', () => {
    for (const plannedEvent of [
      createPlannedEvent({ deliveryMode: 'native' }),
      createPlannedEvent({ durableHandoffQueued: false })
    ]) {
      expect(() =>
        buildFixtureEvidence({
          postResult: { id: 'https://pods.example/alice/as/activity/1' },
          plannedEvent,
          remoteActorUri: 'http://127.0.0.1:8787/actor/success'
        })
      ).toThrow(/external durable-handoff authority/u);
    }
  });

  test('fails closed on Activity identity drift or remote-recipient ambiguity', () => {
    expect(() =>
      buildFixtureEvidence({
        postResult: { id: 'https://pods.example/alice/as/activity/different' },
        plannedEvent: createPlannedEvent(),
        remoteActorUri: 'http://127.0.0.1:8787/actor/success'
      })
    ).toThrow(/does not match the persisted outbox Activity/u);

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
      buildFixtureEvidence({
        postResult: { id: ambiguous.activityId },
        plannedEvent: createPlannedEvent({ deliveryPlan: ambiguous }),
        remoteActorUri: 'http://127.0.0.1:8787/actor/success'
      })
    ).toThrow(/exactly one authoritative remote recipient/u);
  });

  test('does not accept evidence for a different requested remote actor', () => {
    expect(() =>
      buildFixtureEvidence({
        postResult: { id: 'https://pods.example/alice/as/activity/1' },
        plannedEvent: createPlannedEvent(),
        remoteActorUri: 'http://127.0.0.1:8787/actor/transient'
      })
    ).toThrow(/does not match requested actor/u);
  });
});
