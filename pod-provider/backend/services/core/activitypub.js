const CONFIG = require('../../config/config');
const {
  createActivityPubServiceWithDeliveryStrategy
} = require('../../lib/activitypub-service-with-delivery-strategy');
const { resolvePhase5RemoteAuthority } = require('../../lib/activitypub-phase5-authority');

const authorityState = resolvePhase5RemoteAuthority({
  remoteDeliveryMode: CONFIG.ACTIVITYPUB_REMOTE_DELIVERY_MODE,
  allowExternalDeliveryPreview: CONFIG.ACTIVITYPUB_ALLOW_EXTERNAL_DELIVERY_PREVIEW,
  externalAuthorityCutover: CONFIG.ACTIVITYPUB_EXTERNAL_AUTHORITY_CUTOVER
});

module.exports = createActivityPubServiceWithDeliveryStrategy({
  remoteDeliveryMode: authorityState.mode,
  // Phase 2-4 adapter compatibility latch. In production authority mode this is
  // enabled only after resolvePhase5RemoteAuthority has validated the explicit
  // cutover flag and rejected ambiguous preview/native combinations.
  allowExternalDeliveryPreview: authorityState.compatibilityPreviewGuard,
  settings: {
    baseUri: CONFIG.BASE_URL,
    podProvider: true,
    queueServiceUrl: CONFIG.QUEUE_SERVICE_URL,
    deliveryHandoffUrl: CONFIG.ACTIVITYPUB_DELIVERY_HANDOFF_URL,
    deliveryHandoffToken: CONFIG.ACTIVITYPUB_DELIVERY_HANDOFF_TOKEN,
    deliveryHandoffTimeoutMs: CONFIG.ACTIVITYPUB_DELIVERY_HANDOFF_TIMEOUT_MS
  }
});
