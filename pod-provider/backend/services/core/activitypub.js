const CONFIG = require('../../config/config');
const {
  createActivityPubServiceWithDeliveryStrategy,
  normalizeRemoteDeliveryMode
} = require('../../lib/activitypub-service-with-delivery-strategy');

const remoteDeliveryMode = normalizeRemoteDeliveryMode(CONFIG.ACTIVITYPUB_REMOTE_DELIVERY_MODE);

if (remoteDeliveryMode === 'external' && !CONFIG.ACTIVITYPUB_ALLOW_EXTERNAL_DELIVERY_PREVIEW) {
  throw new Error(
    'SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE=external remains preview-only during APDM Phase 4. ' +
      'Set SEMAPPS_ACTIVITYPUB_ALLOW_EXTERNAL_DELIVERY_PREVIEW=true only in controlled migration environments; ' +
      'production remote-authority cutover is APDM Phase 5.'
  );
}

module.exports = createActivityPubServiceWithDeliveryStrategy({
  remoteDeliveryMode,
  allowExternalDeliveryPreview: CONFIG.ACTIVITYPUB_ALLOW_EXTERNAL_DELIVERY_PREVIEW,
  settings: {
    baseUri: CONFIG.BASE_URL,
    podProvider: true,
    queueServiceUrl: CONFIG.QUEUE_SERVICE_URL,
    deliveryHandoffUrl: CONFIG.ACTIVITYPUB_DELIVERY_HANDOFF_URL,
    deliveryHandoffToken: CONFIG.ACTIVITYPUB_DELIVERY_HANDOFF_TOKEN,
    deliveryHandoffTimeoutMs: CONFIG.ACTIVITYPUB_DELIVERY_HANDOFF_TIMEOUT_MS
  }
});
