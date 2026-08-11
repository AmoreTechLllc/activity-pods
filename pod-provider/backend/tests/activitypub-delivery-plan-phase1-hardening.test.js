'use strict';

const fixture = require('../contracts/ap.delivery-plan.v1.fixture.json');
const {
  canonicalize,
  validateDeliveryPlanV1
} = require('../utils/activitypub-delivery-plan');
const { resolveRemoteDeliveryTarget } = require('../utils/activitypub-delivery-planner');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

describe('APDM Phase 1 contract hardening', () => {
  test('producer rejects searchConsent arrays to match the mirrored schema and Fedify consumer', () => {
    const plan = clone(fixture);
    plan.meta.searchConsent = [];
    expect(validateDeliveryPlanV1(plan)).toBe(false);
  });

  test('delivery endpoints reject fragments and normalization whitespace', () => {
    const fragmented = clone(fixture);
    fragmented.remoteRecipients[0].sharedInboxUrl = 'https://remote.example/inbox#fragment';
    expect(validateDeliveryPlanV1(fragmented)).toBe(false);

    const padded = clone(fixture);
    padded.remoteRecipients[0].sharedInboxUrl = ' https://remote.example/inbox';
    expect(validateDeliveryPlanV1(padded)).toBe(false);
  });

  test('local dataset authority rejects surrounding whitespace/control-character ambiguity', () => {
    const padded = clone(fixture);
    padded.localRecipients[0].dataset = ' bob ';
    expect(validateDeliveryPlanV1(padded)).toBe(false);

    const controlled = clone(fixture);
    controlled.localRecipients[0].dataset = 'bob\nadmin';
    expect(validateDeliveryPlanV1(controlled)).toBe(false);
  });

  test('targetDomain must use canonical lowercase hostname without trailing-dot aliases', () => {
    const aliased = clone(fixture);
    aliased.remoteRecipients[0].sharedInboxUrl = 'https://remote.example./inbox';
    aliased.remoteRecipients[0].targetDomain = 'remote.example.';
    expect(validateDeliveryPlanV1(aliased)).toBe(false);

    const canonical = clone(fixture);
    canonical.remoteRecipients[0].sharedInboxUrl = 'https://remote.example./inbox';
    canonical.remoteRecipients[0].targetDomain = 'remote.example';
    expect(validateDeliveryPlanV1(canonical)).toBe(true);
  });

  test('remote target resolution canonicalizes a trailing-dot hostname before policy keys are created', async () => {
    const ctx = {
      async call(action) {
        expect(action).toBe('activitypub.actor.get');
        return {
          id: 'https://remote.example/users/carol',
          inbox: 'https://remote.example./users/carol/inbox',
          endpoints: { sharedInbox: 'https://remote.example./inbox' }
        };
      }
    };

    const target = await resolveRemoteDeliveryTarget(ctx, 'https://remote.example/users/carol');
    expect(target.targetDomain).toBe('remote.example');
    expect(target.sharedInboxUrl).toBe('https://remote.example./inbox');
  });

  test('contract fingerprint canonicalization rejects non-JSON values instead of creating ambiguous hashes', () => {
    expect(() => canonicalize([undefined])).toThrow(/unsupported undefined/u);
    expect(() => canonicalize({ value: Number.NaN })).toThrow(/non-finite/u);
    expect(() => canonicalize(new Date())).toThrow(/non-JSON object/u);
  });
});
