import { describe, it, expect } from 'vitest';
import { zipToRegion } from '../region';

describe('zipToRegion', () => {
  it('maps a New York ZIP to NY', () => {
    expect(zipToRegion('10001')).toBe('NY');
  });

  it('maps a California ZIP to CA', () => {
    expect(zipToRegion('90001')).toBe('CA');
  });

  it('maps a Virginia ZIP to VA', () => {
    expect(zipToRegion('23220')).toBe('VA');
  });

  it('returns null for a non-5-digit string', () => {
    expect(zipToRegion('abcde')).toBeNull();
    expect(zipToRegion('123')).toBeNull();
  });

  it('returns null for a ZIP3 prefix in no assigned range', () => {
    // 000-004 are unassigned.
    expect(zipToRegion('00100')).toBeNull();
  });
});
