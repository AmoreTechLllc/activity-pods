'use strict';

const { resolvePhase5RemoteAuthority } = require('../lib/activitypub-phase5-authority');

describe('APDM Phase 5 remote authority cutover', () => {
  test('native mode is the deterministic rollback state', () => {
    expect(resolvePhase5RemoteAuthority({ remoteDeliveryMode: 'native' })).toEqual({
      mode: 'native',
      preview: false,
      authority: false,
      compatibilityPreviewGuard: false
    });
  });

  test('controlled preview remains distinct from production authority', () => {
    expect(
      resolvePhase5RemoteAuthority({
        remoteDeliveryMode: 'external',
        allowExternalDeliveryPreview: true,
        externalAuthorityCutover: false
      })
    ).toEqual({
      mode: 'external',
      preview: true,
      authority: false,
      compatibilityPreviewGuard: true
    });
  });

  test('production external authority requires its explicit cutover flag', () => {
    expect(
      resolvePhase5RemoteAuthority({
        remoteDeliveryMode: 'external',
        allowExternalDeliveryPreview: false,
        externalAuthorityCutover: true
      })
    ).toEqual({
      mode: 'external',
      preview: false,
      authority: true,
      compatibilityPreviewGuard: true
    });
  });

  test('external mode without preview or production authority fails closed', () => {
    expect(() =>
      resolvePhase5RemoteAuthority({
        remoteDeliveryMode: 'external',
        allowExternalDeliveryPreview: false,
        externalAuthorityCutover: false
      })
    ).toThrow(/requires either the controlled preview flag or the explicit Phase 5 authority-cutover flag/u);
  });

  test('preview and production authority cannot both be enabled', () => {
    expect(() =>
      resolvePhase5RemoteAuthority({
        remoteDeliveryMode: 'external',
        allowExternalDeliveryPreview: true,
        externalAuthorityCutover: true
      })
    ).toThrow(/mutually exclusive/u);
  });

  test('native rollback rejects stale external-mode flags', () => {
    expect(() =>
      resolvePhase5RemoteAuthority({
        remoteDeliveryMode: 'native',
        externalAuthorityCutover: true
      })
    ).toThrow(/must not carry external preview or Phase 5 authority-cutover flags/u);
    expect(() =>
      resolvePhase5RemoteAuthority({
        remoteDeliveryMode: 'native',
        allowExternalDeliveryPreview: true
      })
    ).toThrow(/must not carry external preview or Phase 5 authority-cutover flags/u);
  });
});
