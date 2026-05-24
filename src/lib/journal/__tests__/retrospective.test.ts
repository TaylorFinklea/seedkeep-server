import { describe, it, expect } from 'vitest';
import { validateMmDd, retrospectiveMmDdWindow } from '../retrospective';

describe('validateMmDd', () => {
  it('accepts valid MM-DD', () => {
    expect(validateMmDd('05-24')).toBe(true);
    expect(validateMmDd('12-31')).toBe(true);
    expect(validateMmDd('01-01')).toBe(true);
  });
  it('rejects malformed input', () => {
    expect(validateMmDd('5-24')).toBe(false);
    expect(validateMmDd('05-32')).toBe(false);
    expect(validateMmDd('13-01')).toBe(false);
    expect(validateMmDd('')).toBe(false);
    expect(validateMmDd('2024-05-24')).toBe(false);
  });
});

describe('retrospectiveMmDdWindow', () => {
  it('returns 7 days centered on the anchor', () => {
    const days = retrospectiveMmDdWindow('05-24');
    expect(days).toEqual(['05-21', '05-22', '05-23', '05-24', '05-25', '05-26', '05-27']);
  });
  it('wraps around year boundary at end', () => {
    const days = retrospectiveMmDdWindow('12-31');
    expect(days.slice(0, 4)).toEqual(['12-28', '12-29', '12-30', '12-31']);
    expect(days.slice(4)).toEqual(['01-01', '01-02', '01-03']);
  });
  it('wraps around year boundary at start', () => {
    const days = retrospectiveMmDdWindow('01-01');
    expect(days.slice(0, 3)).toEqual(['12-29', '12-30', '12-31']);
    expect(days.slice(3)).toEqual(['01-01', '01-02', '01-03', '01-04']);
  });
  it('rejects invalid anchor', () => {
    expect(() => retrospectiveMmDdWindow('13-01')).toThrow('invalid MM-DD');
  });
});
