'use strict';

const REMOTE_DELIVERY_MODES = new Set(['native', 'external']);
const EXPLICIT_PREVIEW_ENVIRONMENTS = new Set(['test', 'development']);

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
 * to native restores the SemApps rollback path even if stale external opt-in
 * flags remain in the environment.
 *
 * Preview is retained only when the runtime explicitly identifies itself as a
 * recognized non-production environment. Missing/unknown NODE_ENV values are
 * production-like for authorization purposes and therefore require the Phase
 * 5 authority cutover flag. This matches the shipped launcher, which may omit
 * NODE_ENV entirely.
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
  const normalizedNodeEnv = String(nodeEnv || '').trim().toLowerCase();
  const previewEnvironment = EXPLICIT_PREVIEW_ENVIRONMENTS.has(normalizedNodeEnv);

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

  // Unset, production, staging, and any unknown environment are fail-closed:
  // preview alone never grants production authority.
  if (!previewEnvironment && !authority) {
    throw new Error(
      'ActivityPub external remote delivery outside an explicit test/development environment requires the Phase 5 authority-cutover flag.'
    );
  }

  if (previewEnvironment && !preview && !authority) {
    throw new Error(
      'ActivityPub external remote delivery requires either the controlled preview flag or the explicit Phase 5 authority-cutover flag.'
    );
  }

  return {
    mode,
    preview: preview && previewEnvironment,
    authority,
    compatibilityPreviewGuard: true
  };
}

module.exports = {
  resolvePhase5RemoteAuthority
};
