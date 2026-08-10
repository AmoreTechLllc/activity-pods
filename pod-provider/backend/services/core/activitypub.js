const CONFIG = require('../../config/config');
const {
  createActivityPubServiceWithDeliveryStrategy,
  normalizeRemoteDeliveryMode
} = require('../../lib/activitypub-service-with-delivery-strategy');

const remoteDeliveryMode = normalizeRemoteDeliveryMode(CONFIG.ACTIVITYPUB_REMOTE_DELIVERY_MODE);

if (remoteDeliveryMode === 'external' && !CONFIG.ACTIVITYPUB_ALLOW_EXTERNAL_DELIVERY_PREVIEW) {
  throw new Error(
    'SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE=external is preview-only during APDM Phase 2. ' +
      'Set SEMAPPS_ACTIVITYPUB_ALLOW_EXTERNAL_DELIVERY_PREVIEW=true only in controlled tests; ' +
      'production cutover waits for the durable handoff phase.'
  );
}

module.exports = createActivityPubServiceWithDeliveryStrategy({
  remoteDeliveryMode,
  allowExternalDeliveryPreview: CONFIG.ACTIVITYPUB_ALLOW_EXTERNAL_DELIVERY_PREVIEW,
  settings: {
    baseUri: CONFIG.BASE_URL,
    podProvider: true,
    queueServiceUrl: CONFIG.QUEUE_SERVICE_URL
  }
});
