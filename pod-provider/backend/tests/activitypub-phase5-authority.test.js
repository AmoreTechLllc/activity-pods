'use strict';

const { resolvePhase5RemoteAuthority } = require('../lib/activitypub-phase5-authority');

describe('APDM Phase 5 remote authority cutover', () => {
  test('native mode is the deterministic one-switch rollback state even with stale external flags', () => {
    for (const nodeEnv of [undefined, 'production', 'staging']) {
      for (const staleFlags of [
        {},
        { allowExternalDeliveryPreview: true },
        { externalAuthorityCutover: true },
        { allowExternalDeliveryPreview: true, externalAuthorityCutover: true }
      ]) {
        expect(resolvePhase5RemoteAuthority({ remoteDeliveryMode: 'native', nodeEnv, ...staleFlags })).toEqual({
          mode: 'native',
          preview: false,
          authority: false,
          compatibilityPreviewGuard: false
        });
      }
    }
  });

  test.each(['test', 'development'])('controlled preview is allowed only in explicit %s environment', nodeEnv => {
    expect(
      resolvePhase5RemoteAuthority({
        remoteDeliveryMode: 'external',
        allowExternalDeliveryPreview: true,
        externalAuthorityCutover: false,
        nodeEnv
      })
    ).toEqual({
      mode: 'external',
      preview: true,
      authority: false,
      compatibilityPreviewGuard: true
    });
  });

  test.each([undefined, '', 'production', 'staging', 'qa'])('preview-only external mode fails closed for production-like environment %p', nodeEnv => {
    expect(() =>
      resolvePhase5RemoteAuthority({
        remoteDeliveryMode: 'external',
        allowExternalDeliveryPreview: true,
        externalAuthorityCutover: false,
        nodeEnv
      })
    ).toThrow(/outside an explicit test\/development environment requires the Phase 5 authority-cutover flag/u);
  });

  test.each([undefined, '', 'production', 'staging'])('explicit Phase 5 authority works in production-like environment %p', nodeEnv => {
    expect(
      resolvePhase5RemoteAuthority({
        remoteDeliveryMode: 'external',
        allowExternalDeliveryPreview: false,
        externalAuthorityCutover: true,
        nodeEnv
      })
    ).toEqual({
      mode: 'external',
      preview: false,
      authority: true,
      compatibilityPreviewGuard: true
    });
  });

  test('explicit preview environment without either authorization fails closed', () => {
    expect(() =>
      resolvePhase5RemoteAuthority({
        remoteDeliveryMode: 'external',
        allowExternalDeliveryPreview: false,
        externalAuthorityCutover: false,
        nodeEnv: 'test'
      })
    ).toThrow(/requires either the controlled preview flag or the explicit Phase 5 authority-cutover flag/u);
  });

  test('preview and production authority cannot both be enabled in any environment', () => {
    for (const nodeEnv of [undefined, 'test', 'development', 'production', 'staging']) {
      expect(() =>
        resolvePhase5RemoteAuthority({
          remoteDeliveryMode: 'external',
          allowExternalDeliveryPreview: true,
          externalAuthorityCutover: true,
          nodeEnv
        })
      ).toThrow(/mutually exclusive/u);
    }
  });
});
