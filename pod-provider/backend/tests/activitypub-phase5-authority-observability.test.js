'use strict';

const {
  describeAuthorityState,
  resolvePhase5RemoteAuthority
} = require('../lib/activitypub-phase5-authority');

describe('APDM Phase 5 remote-delivery authority observability', () => {
  test('native remains the one-switch rollback even with stale external flags', () => {
    expect(
      resolvePhase5RemoteAuthority({
        remoteDeliveryMode: 'native',
        allowExternalDeliveryPreview: true,
        externalAuthorityCutover: true,
        nodeEnv: 'production'
      })
    ).toEqual({
      mode: 'native',
      preview: false,
      authority: false,
      compatibilityPreviewGuard: false,
      deliveryExecutor: 'semapps-native',
      authorityProfile: 'native-rollback',
      productionCanonical: false,
      sidecarDeliveryAuthority: false
    });
  });

  test('production external cutover identifies the sidecar as canonical delivery authority', () => {
    expect(
      resolvePhase5RemoteAuthority({
        remoteDeliveryMode: 'external',
        externalAuthorityCutover: true,
        nodeEnv: 'production'
      })
    ).toEqual({
      mode: 'external',
      preview: false,
      authority: true,
      compatibilityPreviewGuard: true,
      deliveryExecutor: 'sidecar-external',
      authorityProfile: 'external-production-authority',
      productionCanonical: true,
      sidecarDeliveryAuthority: true
    });
  });

  test('controlled development preview uses the sidecar without claiming production canonicality', () => {
    expect(
      resolvePhase5RemoteAuthority({
        remoteDeliveryMode: 'external',
        allowExternalDeliveryPreview: true,
        externalAuthorityCutover: false,
        nodeEnv: 'development'
      })
    ).toEqual({
      mode: 'external',
      preview: true,
      authority: false,
      compatibilityPreviewGuard: true,
      deliveryExecutor: 'sidecar-external',
      authorityProfile: 'external-preview',
      productionCanonical: false,
      sidecarDeliveryAuthority: true
    });
  });

  test.each(['production', 'staging', '', undefined])(
    'external mode fails closed without authority cutover in production-like environment %p',
    nodeEnv => {
      expect(() =>
        resolvePhase5RemoteAuthority({
          remoteDeliveryMode: 'external',
          externalAuthorityCutover: false,
          nodeEnv
        })
      ).toThrow(/requires the Phase 5 authority-cutover flag/u);
    }
  );

  test('external preview and production authority cannot both be enabled', () => {
    expect(() =>
      resolvePhase5RemoteAuthority({
        remoteDeliveryMode: 'external',
        allowExternalDeliveryPreview: true,
        externalAuthorityCutover: true,
        nodeEnv: 'development'
      })
    ).toThrow(/mutually exclusive/u);
  });

  test('development external mode fails closed when neither preview nor authority was explicitly selected', () => {
    expect(() =>
      resolvePhase5RemoteAuthority({
        remoteDeliveryMode: 'external',
        nodeEnv: 'development'
      })
    ).toThrow(/requires either the controlled preview flag or the explicit Phase 5 authority-cutover flag/u);
  });

  test('authority descriptor never infers production canonicality from external mode alone', () => {
    expect(
      describeAuthorityState({
        mode: 'external',
        preview: true,
        authority: false,
        compatibilityPreviewGuard: true
      })
    ).toEqual(
      expect.objectContaining({
        deliveryExecutor: 'sidecar-external',
        authorityProfile: 'external-preview',
        productionCanonical: false,
        sidecarDeliveryAuthority: true
      })
    );
  });
});
