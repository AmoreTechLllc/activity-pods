'use strict';

const {
  resolvePhase6ObservationConfig
} = require('../lib/activitypub-phase6-observation-config');

function nativeConfig(overrides = {}) {
  return {
    remoteDeliveryMode: 'native',
    sidecarObservationWebhookUrl: 'http://fedify-sidecar:8080/webhook/outbox-observation',
    sidecarToken: 'secret',
    observationWebhookRetries: '3',
    observationWebhookTimeoutMs: '5000',
    ...overrides
  };
}

describe('APDM Phase 6 native observation configuration', () => {
  test('accepts the authenticated targetless native observation path', () => {
    expect(resolvePhase6ObservationConfig(nativeConfig())).toEqual({
      remoteDeliveryMode: 'native',
      sidecarObservationWebhookUrl: 'http://fedify-sidecar:8080/webhook/outbox-observation',
      sidecarToken: 'secret',
      observationWebhookRetries: 3,
      observationWebhookTimeoutMs: 5000
    });
  });

  test.each([
    'ftp://fedify-sidecar/outbox-observation',
    ' http://fedify-sidecar/outbox-observation',
    'http://fedify-sidecar/outbox-observation ',
    'http://user:pass@fedify-sidecar/outbox-observation',
    'http://fedify-sidecar/outbox-observation#fragment'
  ])('rejects unsafe native observation URL %p', sidecarObservationWebhookUrl => {
    expect(() => resolvePhase6ObservationConfig(nativeConfig({ sidecarObservationWebhookUrl }))).toThrow(
      /credential-free HTTP\(S\)/u
    );
  });

  test.each(['', ' ', ' secret', 'secret '])('rejects unusable native sidecar token %p', sidecarToken => {
    expect(() => resolvePhase6ObservationConfig(nativeConfig({ sidecarToken }))).toThrow(/SIDECAR_TOKEN/u);
  });

  test.each(['0', '-1', '1.5', 'abc', '21'])('rejects invalid native observation retry count %p', observationWebhookRetries => {
    expect(() => resolvePhase6ObservationConfig(nativeConfig({ observationWebhookRetries }))).toThrow(/retries/u);
  });

  test.each(['99', '60001', '1.5', 'abc'])('rejects invalid native observation timeout %p', observationWebhookTimeoutMs => {
    expect(() => resolvePhase6ObservationConfig(nativeConfig({ observationWebhookTimeoutMs }))).toThrow(/timeout/u);
  });

  test('external mode does not acquire a dependency on the native-only observation endpoint', () => {
    expect(resolvePhase6ObservationConfig({
      remoteDeliveryMode: 'external',
      sidecarObservationWebhookUrl: '',
      sidecarToken: '',
      observationWebhookRetries: '3',
      observationWebhookTimeoutMs: '5000'
    })).toEqual({
      remoteDeliveryMode: 'external',
      sidecarObservationWebhookUrl: '',
      sidecarToken: '',
      observationWebhookRetries: 3,
      observationWebhookTimeoutMs: 5000
    });
  });

  test('rejects ambiguous delivery mode independently of the Phase 5 authority loader', () => {
    expect(() => resolvePhase6ObservationConfig(nativeConfig({ remoteDeliveryMode: 'externl' }))).toThrow(
      /Unsupported ActivityPub remote delivery mode/u
    );
  });
});
