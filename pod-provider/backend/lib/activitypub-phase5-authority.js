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
 * `native` is deliberately dominant: changing only REMOTE_DELIVERY_MODE back
 * to native must restore the SemApps rollback path even if stale external
 * opt-in flags remain in the environment.
 *
 * Preview is retained only for non-production controlled migration tests.
 * Production external authority always requires the explicit cutover flag.
 * Preview and production authority remain mutually exclusive so the active
 * contract is unambiguous.
 */
function resolvePhase5RemoteAuthority({
  remoteDeliveryMode,
  allowExternalDeliveryPreview = false,
  externalAuthorityCutover = false,
  nodeEnv = process.env.NODE_ENV
} = {}) {
  const mode = normalizeMode(remoteDeliveryMode);
  const preview = allowExternalDeliveryPreview === true;
  const authority = externalAuthorityCutover === true;
  const production = String(nodeEnv || '').trim().toLowerCase() === 'production';

  // Emergency rollback is intentionally one switch: native wins over stale
  // external flags and restores the original SemApps remote executor.
  if (mode === 'native') {
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

  if (production && !authority) {
    throw new Error(
      'Production ActivityPub external remote delivery requires the explicit Phase 5 authority-cutover flag.'
    );
  }

  if (!production && !preview && !authority) {
    throw new Error(
      'ActivityPub external remote delivery requires either the controlled preview flag or the explicit Phase 5 authority-cutover flag.'
    );
  }

  return {
    mode,
    preview: preview && !production,
    authority,
    compatibilityPreviewGuard: true
  };
}

module.exports = {
  resolvePhase5RemoteAuthority
};
