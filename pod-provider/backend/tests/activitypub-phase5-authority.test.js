'use strict';

const { resolvePhase5RemoteAuthority } = require('../lib/activitypub-phase5-authority');

describe('APDM Phase 5 remote authority cutover', () => {
  test('native mode is the deterministic one-switch rollback state even with stale external flags', () => {
    for (const staleFlags of [
      {},
      { allowExternalDeliveryPreview: true },
      { externalAuthorityCutover: true },
      { allowExternalDeliveryPreview: true, externalAuthorityCutover: true }
    ]) {
      expect(resolvePhase5RemoteAuthority({ remoteDeliveryMode: 'native', nodeEnv: 'production', ...staleFlags })).toEqual({
        mode: 'native',
        preview: false,
        authority: false,
        compatibilityPreviewGuard: false
      });
    }
  });

  test('controlled preview is allowed only outside production', () => {
    expect(
      resolvePhase5RemoteAuthority({
        remoteDeliveryMode: 'external',
        allowExternalDeliveryPreview: true,
        externalAuthorityCutover: false,
        nodeEnv: 'test'
      })
    ).toEqual({
      mode: 'external',
      preview: true,
      authority: false,
      compatibilityPreviewGuard: true
    });

    expect(() =>
      resolvePhase5RemoteAuthority({
        remoteDeliveryMode: 'external',
        allowExternalDeliveryPreview: true,
        externalAuthorityCutover: false,
        nodeEnv: 'production'
      })
    ).toThrow(/Production ActivityPub external remote delivery requires the explicit Phase 5 authority-cutover flag/u);
  });

  test('production external authority requires its explicit cutover flag', () => {
    expect(
      resolvePhase5RemoteAuthority({
        remoteDeliveryMode: 'external',
        allowExternalDeliveryPreview: false,
        externalAuthorityCutover: true,
        nodeEnv: 'production'
      })
    ).toEqual({
      mode: 'external',
      preview: false,
      authority: true,
      compatibilityPreviewGuard: true
    });
  });

  test('non-production external mode without preview or production authority fails closed', () => {
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
    for (const nodeEnv of ['test', 'development', 'production']) {
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
