'use strict';

const {
  describePhase5RemoteAuthority,
  resolvePhase5RemoteAuthority
} = require('../lib/activitypub-phase5-authority');

describe('APDM Phase 5 remote-delivery authority observability', () => {
  test('native rollback keeps the established resolver contract and derives native diagnostics separately', () => {
    const state = resolvePhase5RemoteAuthority({
      remoteDeliveryMode: 'native',
      allowExternalDeliveryPreview: true,
      externalAuthorityCutover: true,
      nodeEnv: 'production'
    });

    expect(state).toEqual({
      mode: 'native',
      preview: false,
      authority: false,
      compatibilityPreviewGuard: false
    });
    expect(describePhase5RemoteAuthority(state)).toEqual({
      deliveryExecutor: 'semapps-native',
      authorityProfile: 'native-rollback',
      productionCanonical: false,
      sidecarDeliveryAuthority: false
    });
  });

  test('production external cutover identifies the sidecar as canonical delivery authority', () => {
    const state = resolvePhase5RemoteAuthority({
      remoteDeliveryMode: 'external',
      externalAuthorityCutover: true,
      nodeEnv: 'production'
    });

    expect(state).toEqual({
      mode: 'external',
      preview: false,
      authority: true,
      compatibilityPreviewGuard: true
    });
    expect(describePhase5RemoteAuthority(state)).toEqual({
      deliveryExecutor: 'sidecar-external',
      authorityProfile: 'external-production-authority',
      productionCanonical: true,
      sidecarDeliveryAuthority: true
    });
  });

  test('controlled development preview uses the sidecar without claiming production canonicality', () => {
    const state = resolvePhase5RemoteAuthority({
      remoteDeliveryMode: 'external',
      allowExternalDeliveryPreview: true,
      externalAuthorityCutover: false,
      nodeEnv: 'development'
    });

    expect(state).toEqual({
      mode: 'external',
      preview: true,
      authority: false,
      compatibilityPreviewGuard: true
    });
    expect(describePhase5RemoteAuthority(state)).toEqual({
      deliveryExecutor: 'sidecar-external',
      authorityProfile: 'external-preview',
      productionCanonical: false,
      sidecarDeliveryAuthority: true
    });
  });

  test.each(['production', 'staging', ''])(
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

  test('diagnostic helper rejects ambiguous unresolved external state', () => {
    expect(() =>
      describePhase5RemoteAuthority({
        mode: 'external',
        preview: false,
        authority: false,
        compatibilityPreviewGuard: true
      })
    ).toThrow(/must be either preview or production authority/u);
  });
});
