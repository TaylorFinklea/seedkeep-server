import { describe, it, expect } from 'vitest';
import { normalizeCropKey } from '../cropMatch';

describe('normalizeCropKey', () => {
  it('lowercases', () => {
    expect(normalizeCropKey('Tomato')).toBe('tomato');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeCropKey('  Lettuce  ')).toBe('lettuce');
  });

  it('collapses internal whitespace', () => {
    expect(normalizeCropKey('Cherry   Tomato')).toBe('cherry tomato');
  });

  it('leaves an already-normalized key unchanged', () => {
    expect(normalizeCropKey('snap bean')).toBe('snap bean');
  });
});
