'use strict';

const fixture = require('../contracts/ap.delivery-plan.v1.fixture.json');
const schema = require('../contracts/ap.delivery-plan.v1.schema.json');
const {
  DELIVERY_PLAN_SCHEMA,
  DELIVERY_PLAN_FIXTURE_SHA256,
  DELIVERY_PLAN_JSON_SCHEMA_SHA256,
  deliveryPlanFingerprint,
  validateDeliveryPlanV1
} = require('../utils/activitypub-delivery-plan');

describe('APDM delivery plan v1 producer contract', () => {
  test('fixture validates against the producer contract helper', () => {
    expect(validateDeliveryPlanV1(fixture)).toBe(true);
  });

  test('fixture has the shared cross-repo fingerprint', () => {
    expect(deliveryPlanFingerprint(fixture)).toBe(DELIVERY_PLAN_FIXTURE_SHA256);
  });

  test('JSON schema has the shared cross-repo fingerprint', () => {
    expect(deliveryPlanFingerprint(schema)).toBe(DELIVERY_PLAN_JSON_SCHEMA_SHA256);
  });

  test('schema and fixture agree on the version discriminator', () => {
    expect(schema.properties.schema.const).toBe(DELIVERY_PLAN_SCHEMA);
    expect(fixture.schema).toBe(DELIVERY_PLAN_SCHEMA);
  });

  test('contract carries both local and remote resolved targets', () => {
    expect(fixture.localRecipients).toEqual([
      expect.objectContaining({
        actorUri: 'https://pods.example/bob',
        dataset: 'bob',
        inboxUri: 'https://pods.example/bob/inbox'
      })
    ]);
    expect(fixture.remoteRecipients).toEqual([
      expect.objectContaining({
        actorUri: 'https://remote.example/users/carol',
        inboxUrl: 'https://remote.example/users/carol/inbox',
        sharedInboxUrl: 'https://remote.example/inbox',
        targetDomain: 'remote.example'
      })
    ]);
  });

  test('rejects an unresolved followers collection masquerading as a remote actor target', () => {
    const invalid = {
      ...fixture,
      remoteRecipients: [
        {
          actorUri: 'https://pods.example/alice/followers',
          inboxUrl: '',
          targetDomain: 'pods.example'
        }
      ]
    };
    expect(validateDeliveryPlanV1(invalid)).toBe(false);
  });
});
