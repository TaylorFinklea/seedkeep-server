import { describe, it, expect } from 'vitest';
import { locationSignature } from '../locationSignature';

describe('locationSignature', () => {
  it('combines zone with quantized lat/lon', () => {
    expect(locationSignature('7a', 39.51, -77.04)).toBe('7a:39.5,-77.0');
  });

  it('quantizes nearby coordinates to the same bucket', () => {
    const a = locationSignature('7a', 39.51, -77.04);
    const b = locationSignature('7a', 39.62, -77.18);
    expect(a).toBe(b); // both round to 39.5,-77.0 at 0.5-degree buckets
  });
});
