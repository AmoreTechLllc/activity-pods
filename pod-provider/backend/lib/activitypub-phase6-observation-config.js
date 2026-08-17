'use strict';

const REMOTE_DELIVERY_MODES = new Set(['native', 'external']);

function normalizeRemoteDeliveryMode(value) {
  const normalized = value === undefined || value === null ? 'native' : String(value).trim().toLowerCase();
  if (!REMOTE_DELIVERY_MODES.has(normalized)) {
    throw new Error(`Unsupported ActivityPub remote delivery mode '${value}'. Expected native or external.`);
  }
  return normalized;
}

function parseExactHttpUrl(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.includes('#')) {
    throw new Error(`${label} must be an exact credential-free HTTP(S) URL without fragments or whitespace padding`);
  }
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('unsafe');
    return parsed.toString();
  } catch {
    throw new Error(`${label} must be an exact credential-free HTTP(S) URL without fragments or whitespace padding`);
  }
}

function parseInteger(value, fallback, { label, min, max }) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string' && !/^[1-9]\d*$/u.test(value)) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function resolvePhase6ObservationConfig({
  remoteDeliveryMode,
  sidecarObservationWebhookUrl,
  sidecarToken,
  observationWebhookRetries,
  observationWebhookTimeoutMs
} = {}) {
  const mode = normalizeRemoteDeliveryMode(remoteDeliveryMode);
  const retries = parseInteger(observationWebhookRetries, 3, {
    label: 'ActivityPub observation webhook retries',
    min: 1,
    max: 20
  });
  const timeoutMs = parseInteger(observationWebhookTimeoutMs, 5000, {
    label: 'ActivityPub observation webhook timeout',
    min: 100,
    max: 60000
  });

  // External authority never invokes the legacy/native observation transport.
  // Do not make external startup depend on an endpoint it cannot use.
  if (mode === 'external') {
    return {
      remoteDeliveryMode: mode,
      sidecarObservationWebhookUrl,
      sidecarToken,
      observationWebhookRetries: retries,
      observationWebhookTimeoutMs: timeoutMs
    };
  }

  const url = parseExactHttpUrl(
    sidecarObservationWebhookUrl,
    'ActivityPub native observation webhook URL'
  );
  if (
    typeof sidecarToken !== 'string' ||
    sidecarToken.length === 0 ||
    sidecarToken !== sidecarToken.trim()
  ) {
    throw new Error('ActivityPub native observation requires a nonblank unpadded SIDECAR_TOKEN');
  }

  return {
    remoteDeliveryMode: mode,
    sidecarObservationWebhookUrl: url,
    sidecarToken,
    observationWebhookRetries: retries,
    observationWebhookTimeoutMs: timeoutMs
  };
}

module.exports = {
  normalizeRemoteDeliveryMode,
  parseExactHttpUrl,
  parseInteger,
  resolvePhase6ObservationConfig
};
