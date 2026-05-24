import { describe, it, expect } from 'vitest';
import { locationSignature } from '../locationSignature';

describe('locationSignature', () => {
  it('combines zone with quantized lat/lon and a region segment', () => {
    expect(locationSignature('7a', 39.51, -77.04, 'VA')).toBe('7a:39.5,-77.0:VA');
  });

  it("emits ':none' when regionId is null or omitted", () => {
    expect(locationSignature('7a', 39.51, -77.04)).toBe('7a:39.5,-77.0:none');
    expect(locationSignature('7a', 39.51, -77.04, null)).toBe('7a:39.5,-77.0:none');
  });

  it('quantizes nearby coordinates to the same bucket', () => {
    const a = locationSignature('7a', 39.51, -77.04, 'VA');
    const b = locationSignature('7a', 39.62, -77.18, 'VA');
    expect(a).toBe(b); // both round to 39.5,-77.0 at 0.5-degree buckets
  });

  it('produces different signatures when regionId differs', () => {
    // Crucial invariant: adding extension coverage for a new region must
    // force a cache miss for that region's households so they re-compute
    // through the extension lookup instead of returning a stale rule row.
    const before = locationSignature('6b', 39.0, -95.0, null);
    const after  = locationSignature('6b', 39.0, -95.0, 'KS');
    expect(before).not.toBe(after);
  });
});
