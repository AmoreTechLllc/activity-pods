'use strict';

const {
  assertExternalDeliveryConfiguration
} = require('../lib/activitypub-service-with-delivery-strategy');

function settings(timeout) {
  return {
    remoteDeliveryMode: 'external',
    allowExternalDeliveryPreview: true,
    queueServiceUrl: 'redis://queue.example:6379',
    deliveryHandoffUrl: 'http://fedify-sidecar:8080/webhook/outbox',
    deliveryHandoffToken: 'secret',
    deliveryHandoffTimeoutMs: timeout
  };
}

describe('APDM Phase 2 handoff timeout startup validation', () => {
  test('rejects fractional timeouts before AbortSignal.timeout can fail in a worker', () => {
    expect(() => assertExternalDeliveryConfiguration(settings(100.5))).toThrow(/integer between 100 and 60000/u);
    expect(() => assertExternalDeliveryConfiguration(settings(5000))).not.toThrow();
  });
});
