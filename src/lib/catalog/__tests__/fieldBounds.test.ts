/**
 * Phase 4D · fieldBounds unit tests.
 *
 * Exhaustive per-field bounds + SHA-256 parity against the canonical JSON
 * mirror that iOS imports. Any drift between the two breaks the build.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUTO_APPLY_FIELDS,
  CORRECTABLE_FIELDS,
  ENUM_VALUES,
  SANITY_BOUNDS,
  SUSPECT_THRESHOLDS,
  describeBounds,
  fieldBoundsSnapshot,
  validateFieldValue,
} from '../fieldBounds';

describe('CORRECTABLE_FIELDS / AUTO_APPLY_FIELDS', () => {
  it('AUTO_APPLY_FIELDS is a subset of CORRECTABLE_FIELDS', () => {
    for (const field of AUTO_APPLY_FIELDS) {
      expect(CORRECTABLE_FIELDS.has(field)).toBe(true);
    }
  });

  it('free-text fields are correctable but not auto-applyable', () => {
    for (const field of ['scientific_name', 'common_name', 'variety', 'company', 'instructions']) {
      expect(CORRECTABLE_FIELDS.has(field)).toBe(true);
      expect(AUTO_APPLY_FIELDS.has(field)).toBe(false);
    }
  });

  it('rejects unknown fields by default (default-deny)', () => {
    expect(CORRECTABLE_FIELDS.has('barcode')).toBe(false);
    expect(CORRECTABLE_FIELDS.has('perceptual_hash')).toBe(false);
    expect(CORRECTABLE_FIELDS.has('does_not_exist')).toBe(false);
  });
});

describe('validateFieldValue — numeric bounds', () => {
  it('accepts in-range integer values', () => {
    const r = validateFieldValue('days_to_maturity_min', '60');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe(60);
  });

  it('rejects below-min integer values', () => {
    const r = validateFieldValue('soil_temp_min_f', '18');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('out_of_bounds');
  });

  it('rejects above-max integer values', () => {
    const r = validateFieldValue('days_to_maturity_max', '500');
    expect(r.ok).toBe(false);
  });

  it('rejects NUMERIC(3,2) overflow (seed_depth_inches > 9.99)', () => {
    const r = validateFieldValue('seed_depth_inches', '10.0');
    expect(r.ok).toBe(false);
  });

  it('marks seed_depth_inches > 3 as requires_human (but ok)', () => {
    const r = validateFieldValue('seed_depth_inches', '3.5');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized).toBe(3.5);
      expect(r.requires_human).toBe(true);
    }
  });

  it('marks plant_spacing_inches > 96 as requires_human', () => {
    const r = validateFieldValue('plant_spacing_inches', '120');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.requires_human).toBe(true);
  });

  it('rejects non-integer for integer fields', () => {
    const r = validateFieldValue('days_to_maturity_min', '60.5');
    expect(r.ok).toBe(false);
  });

  it('rejects non-numeric strings', () => {
    const r = validateFieldValue('days_to_maturity_min', 'sixty');
    expect(r.ok).toBe(false);
  });
});

describe('validateFieldValue — enums', () => {
  it('accepts canonical enum values', () => {
    expect(validateFieldValue('sun_requirement', 'full').ok).toBe(true);
    expect(validateFieldValue('frost_tolerance', 'half_hardy').ok).toBe(true);
    expect(validateFieldValue('sow_method', 'either').ok).toBe(true);
    expect(validateFieldValue('life_cycle', 'perennial').ok).toBe(true);
  });

  it('normalizes case', () => {
    const r = validateFieldValue('sun_requirement', 'FULL');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('full');
  });

  it('rejects unknown enum values with bounds_hint listing valid ones', () => {
    const r = validateFieldValue('sun_requirement', 'half-day');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('invalid_enum');
      expect(r.bounds_hint).toContain('full');
      expect(r.bounds_hint).toContain('partial');
      expect(r.bounds_hint).toContain('shade');
    }
  });
});

describe('validateFieldValue — free text', () => {
  it('accepts a benign botanical name', () => {
    const r = validateFieldValue('scientific_name', 'Solanum lycopersicum');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.requires_human).toBe(true);
  });

  it('rejects empty / whitespace-only', () => {
    expect(validateFieldValue('scientific_name', '').ok).toBe(false);
    expect(validateFieldValue('scientific_name', '   ').ok).toBe(false);
  });
});

describe('describeBounds', () => {
  it('produces a numeric range string', () => {
    expect(describeBounds('days_to_maturity_min')).toContain('5');
    expect(describeBounds('days_to_maturity_min')).toContain('365');
  });
  it('produces an enum list string', () => {
    const s = describeBounds('sun_requirement');
    expect(s).toContain('full');
    expect(s).toContain('partial');
    expect(s).toContain('shade');
  });
});

describe('fieldBoundsSnapshot — SHA-256 parity vs canonical JSON', () => {
  it('matches the checked-in canonical JSON', () => {
    const snapshot = fieldBoundsSnapshot();
    const file = readFileSync(
      join(__dirname, '..', 'fieldBounds.canonical.json'),
      'utf-8',
    );
    const canonical = JSON.parse(file);

    // Compare the snapshot's hash to the hash of the file's JSON content
    // (re-stringified deterministically). Any drift in either side
    // breaks the build.
    const snapHash = createHash('sha256')
      .update(JSON.stringify(snapshot))
      .digest('hex');
    const fileHash = createHash('sha256')
      .update(JSON.stringify(canonical))
      .digest('hex');
    expect(snapHash).toBe(fileHash);
  });

  it('snapshot includes every CORRECTABLE_FIELDS entry', () => {
    const snap = fieldBoundsSnapshot();
    expect(new Set(snap.correctableFields)).toEqual(CORRECTABLE_FIELDS);
  });

  it('snapshot includes every AUTO_APPLY_FIELDS entry', () => {
    const snap = fieldBoundsSnapshot();
    expect(new Set(snap.autoApplyFields)).toEqual(AUTO_APPLY_FIELDS);
  });

  it('snapshot covers all SANITY_BOUNDS keys', () => {
    const snap = fieldBoundsSnapshot();
    expect(Object.keys(snap.sanityBounds).sort()).toEqual(
      Object.keys(SANITY_BOUNDS).sort(),
    );
  });

  it('snapshot covers all SUSPECT_THRESHOLDS keys', () => {
    const snap = fieldBoundsSnapshot();
    expect(Object.keys(snap.suspectThresholds).sort()).toEqual(
      Object.keys(SUSPECT_THRESHOLDS).sort(),
    );
  });

  it('snapshot covers all ENUM_VALUES keys', () => {
    const snap = fieldBoundsSnapshot();
    expect(Object.keys(snap.enumValues).sort()).toEqual(
      Object.keys(ENUM_VALUES).sort(),
    );
  });
});
