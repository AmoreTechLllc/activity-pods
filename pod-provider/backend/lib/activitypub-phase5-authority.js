'use strict';

const REMOTE_DELIVERY_MODES = new Set(['native', 'external']);

function normalizeMode(value) {
  const normalized = value === undefined || value === null ? 'native' : String(value).trim().toLowerCase();
  if (!REMOTE_DELIVERY_MODES.has(normalized)) {
    throw new Error(`Unsupported ActivityPub remote delivery mode '${value}'. Expected native or external.`);
  }
  return normalized;
}

/**
 * Resolve the APDM Phase 5 remote-authority state without weakening the
 * existing Phase 2-4 interception/handoff machinery.
 *
 * Preview is retained for controlled migration tests. Production authority is
 * a separate explicit switch. They are mutually exclusive so an operator can
 * always tell which safety contract is active from configuration alone.
 *
 * The returned compatibilityPreviewGuard is intentionally internal: the
 * Phase 2-4 adapter still uses the old preview boolean as its final opt-in
 * latch. During Phase 5 authority mode we satisfy that latch only after this
 * stronger cutover decision has succeeded. Phase 6 may remove that temporary
 * compatibility seam after rollback/parity proof is complete.
 */
function resolvePhase5RemoteAuthority({
  remoteDeliveryMode,
  allowExternalDeliveryPreview = false,
  externalAuthorityCutover = false
} = {}) {
  const mode = normalizeMode(remoteDeliveryMode);
  const preview = allowExternalDeliveryPreview === true;
  const authority = externalAuthorityCutover === true;

  if (mode === 'native') {
    if (preview || authority) {
      throw new Error(
        'ActivityPub native remote delivery must not carry external preview or Phase 5 authority-cutover flags.'
      );
    }
    return {
      mode,
      preview: false,
      authority: false,
      compatibilityPreviewGuard: false
    };
  }

  if (preview && authority) {
    throw new Error(
      'ActivityPub external preview and Phase 5 production authority cutover are mutually exclusive.'
    );
  }
  if (!preview && !authority) {
    throw new Error(
      'ActivityPub external remote delivery requires either the controlled preview flag or the explicit Phase 5 authority-cutover flag.'
    );
  }

  return {
    mode,
    preview,
    authority,
    compatibilityPreviewGuard: true
  };
}

module.exports = {
  resolvePhase5RemoteAuthority
};
