const CONFIG = require('../../config/config');
const {
  createActivityPubServiceWithDeliveryStrategy
} = require('../../lib/activitypub-service-with-delivery-strategy');
const {
  describePhase5RemoteAuthority,
  resolvePhase5RemoteAuthority
} = require('../../lib/activitypub-phase5-authority');
const {
  enqueueDeliveryHandoffWithObservation
} = require('../../lib/activitypub-phase5-observation-handoff');

const authorityState = resolvePhase5RemoteAuthority({
  remoteDeliveryMode: CONFIG.ACTIVITYPUB_REMOTE_DELIVERY_MODE,
  allowExternalDeliveryPreview: CONFIG.ACTIVITYPUB_ALLOW_EXTERNAL_DELIVERY_PREVIEW,
  externalAuthorityCutover: CONFIG.ACTIVITYPUB_EXTERNAL_AUTHORITY_CUTOVER
});
const authorityDiagnostic = describePhase5RemoteAuthority(authorityState);

const activityPubService = createActivityPubServiceWithDeliveryStrategy({
  remoteDeliveryMode: authorityState.mode,
  // Phase 2-4 adapter compatibility latch. In production authority mode this is
  // enabled only after resolvePhase5RemoteAuthority has validated the explicit
  // cutover flag and rejected ambiguous preview/native combinations.
  allowExternalDeliveryPreview: authorityState.compatibilityPreviewGuard,
  // Phase 5 keeps committed search consent/indexability on the same durable
  // Delivery Plan handoff used by live posting and reconciliation. This is an
  // observation decorator only; it does not create a second federation path.
  enqueueHandoff: enqueueDeliveryHandoffWithObservation,
  settings: {
    baseUri: CONFIG.BASE_URL,
    podProvider: true,
    queueServiceUrl: CONFIG.QUEUE_SERVICE_URL,
    deliveryHandoffUrl: CONFIG.ACTIVITYPUB_DELIVERY_HANDOFF_URL,
    deliveryHandoffToken: CONFIG.ACTIVITYPUB_DELIVERY_HANDOFF_TOKEN,
    deliveryHandoffTimeoutMs: CONFIG.ACTIVITYPUB_DELIVERY_HANDOFF_TIMEOUT_MS,
    // Safe, non-secret operational state. Operators must be able to distinguish
    // "sidecar is installed" from "sidecar is the active remote-delivery
    // authority" without inferring it from queue traffic after deployment.
    remoteDeliveryExecutor: authorityDiagnostic.deliveryExecutor,
    remoteDeliveryAuthorityProfile: authorityDiagnostic.authorityProfile,
    remoteDeliveryProductionCanonical: authorityDiagnostic.productionCanonical,
    sidecarDeliveryAuthority: authorityDiagnostic.sidecarDeliveryAuthority,
    externalAuthorityCutover: authorityState.authority,
    externalDeliveryPreview: authorityState.preview
  }
});

const createActivityPubSubservices = activityPubService.created;
activityPubService.created = function createdWithAuthorityDiagnostic() {
  this.logger.info('ActivityPub remote delivery authority resolved', {
    executor: authorityDiagnostic.deliveryExecutor,
    profile: authorityDiagnostic.authorityProfile,
    productionCanonical: authorityDiagnostic.productionCanonical,
    sidecarDeliveryAuthority: authorityDiagnostic.sidecarDeliveryAuthority,
    externalAuthorityCutover: authorityState.authority,
    externalDeliveryPreview: authorityState.preview
  });

  if (!authorityDiagnostic.sidecarDeliveryAuthority) {
    this.logger.warn(
      'ActivityPub remote delivery remains under SemApps native authority; the federation sidecar is observation-only until explicit external authority cutover.'
    );
  }

  return createActivityPubSubservices.call(this);
};

module.exports = activityPubService;