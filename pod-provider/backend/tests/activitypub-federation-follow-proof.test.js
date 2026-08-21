'use strict';

const {
  boundedNonNegativeInteger,
  createProofSummary
} = require('../scripts/activitypub-federation-follow-proof');

describe('ActivityPub real federation proof payload', () => {
  test('keeps the normal proof unpadded by default', () => {
    expect(boundedNonNegativeInteger(undefined, 0, 64 * 1024, 'proof summary bytes')).toBe(0);
    expect(createProofSummary(0)).toBeUndefined();
  });

  test('creates an exact-size ASCII summary suitable for a real compressible Activity', () => {
    const summary = createProofSummary(8192);
    expect(Buffer.byteLength(summary, 'utf8')).toBe(8192);
    expect(summary.startsWith('activitypods-sidecar-compression-proof|')).toBe(true);
  });

  test('rejects negative, fractional, non-numeric, and oversized proof sizes', () => {
    const parse = value => boundedNonNegativeInteger(value, 0, 64 * 1024, 'proof summary bytes');
    expect(() => parse(-1)).toThrow(/between 0 and 65536/u);
    expect(() => parse(1.5)).toThrow(/between 0 and 65536/u);
    expect(() => parse('not-a-number')).toThrow(/between 0 and 65536/u);
    expect(() => parse(64 * 1024 + 1)).toThrow(/between 0 and 65536/u);
  });

  test('accepts the maximum bounded proof size without exceeding it', () => {
    const bytes = boundedNonNegativeInteger(64 * 1024, 0, 64 * 1024, 'proof summary bytes');
    const summary = createProofSummary(bytes);
    expect(Buffer.byteLength(summary, 'utf8')).toBe(64 * 1024);
  });
});
