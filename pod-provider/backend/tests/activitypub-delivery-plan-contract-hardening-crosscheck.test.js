'use strict';

const fixture = require('../contracts/ap.delivery-plan.v1.fixture.json');
const followersFixture = require('../contracts/ap.delivery-plan.v1.followers-only.fixture.json');
const {
  computeDeliveryPlanIntentId,
  validateDeliveryPlanV1
} = require('../utils/activitypub-delivery-plan');

function expectedIntent(plan) {
  return computeDeliveryPlanIntentId({
    activityId: plan.activityId,
    actorUri: plan.actorUri,
    localRecipientUris: plan.localRecipients.map(target => target.actorUri),
    remoteRecipientUris: plan.remoteRecipients.map(target => target.actorUri)
  });
}

describe('APDM hardened fixture semantic cross-check', () => {
  test.each([fixture, followersFixture])('fixture carries its computed deterministic intent ID', plan => {
    expect(plan.intentId).toBe(expectedIntent(plan));
    expect(validateDeliveryPlanV1(plan)).toBe(true);
  });
});
