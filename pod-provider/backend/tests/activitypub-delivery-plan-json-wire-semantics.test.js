'use strict';

const {
  sanitizeDeliveryActivity,
  validateDeliveryPlanV1
} = require('../utils/activitypub-delivery-plan');
const { buildDeliveryPlanV1 } = require('../utils/activitypub-delivery-planner');

const ACTOR = 'https://pods.example/alice';
const REMOTE = 'https://remote.example/users/bob';

function remoteCtx() {
  return {
    async call(action, params) {
      if (action !== 'activitypub.actor.get') throw new Error(`Unexpected call ${action}`);
      return {
        id: params.actorUri,
        inbox: `${params.actorUri}/inbox`
      };
    }
  };
}

describe('ActivityPub Delivery Plan JSON wire semantics', () => {
  test('omits undefined object properties like native SemApps JSON.stringify delivery', () => {
    const input = {
      id: `${ACTOR}/activities/undefined-capability`,
      type: 'Create',
      actor: ACTOR,
      capability: undefined,
      object: {
        type: 'Note',
        content: 'wire semantics',
        optional: undefined
      }
    };

    const sanitized = sanitizeDeliveryActivity(input);

    expect(sanitized).toEqual({
      id: `${ACTOR}/activities/undefined-capability`,
      type: 'Create',
      actor: ACTOR,
      object: {
        type: 'Note',
        content: 'wire semantics'
      }
    });
    expect(Object.prototype.hasOwnProperty.call(sanitized, 'capability')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(sanitized.object, 'optional')).toBe(false);
    expect(JSON.stringify(sanitized)).toBe(JSON.stringify(input));
  });

  test('planner accepts the SemApps absent-capability shape and emits a valid plan', async () => {
    const activity = {
      id: `${ACTOR}/activities/semapps-capability`,
      type: 'Create',
      actor: ACTOR,
      to: [REMOTE],
      cc: [],
      object: {
        id: `${ACTOR}/objects/semapps-capability`,
        type: 'Note',
        attributedTo: ACTOR,
        content: 'wire semantics'
      },
      // SemApps reattaches this own property after the persisted Activity is
      // fetched even when the original outbox request did not provide it.
      capability: undefined
    };

    const plan = await buildDeliveryPlanV1(remoteCtx(), {
      activity,
      remoteRecipientUris: [REMOTE]
    });

    expect(Object.prototype.hasOwnProperty.call(plan.activity, 'capability')).toBe(false);
    expect(JSON.stringify(plan.activity)).toBe(JSON.stringify(activity));
    expect(validateDeliveryPlanV1(plan)).toBe(true);
  });

  test('continues to fail closed on undefined array entries and non-JSON values', () => {
    expect(() => sanitizeDeliveryActivity([undefined])).toThrow(/unsupported undefined/u);
    expect(() => sanitizeDeliveryActivity({ object: { tags: [undefined] } })).toThrow(/unsupported undefined/u);
    expect(() => sanitizeDeliveryActivity({ unsupported: () => true })).toThrow(/unsupported function/u);
    expect(() => sanitizeDeliveryActivity({ unsupported: Symbol('x') })).toThrow(/unsupported symbol/u);
    expect(() => sanitizeDeliveryActivity(new Array(1))).toThrow(/sparse array/u);
    expect(() => sanitizeDeliveryActivity({ value: Number.NaN })).toThrow(/non-finite/u);
    expect(() => sanitizeDeliveryActivity({ value: new Date() })).toThrow(/non-JSON ActivityPub delivery object/u);
  });
});
