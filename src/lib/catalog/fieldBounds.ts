/**
 * Phase 4D · Field bounds + allowlists for catalog correction policy.
 *
 * Source of truth for everything that gates which catalog_seeds columns
 * can be edited by users (`CORRECTABLE_FIELDS`) and which of those edits
 * may bypass the human reviewer (`AUTO_APPLY_FIELDS`). Both sets are
 * default-deny: any column added to `catalog_seeds` in the future is
 * uncorrectable until explicitly listed here.
 *
 * Mirrored to iOS via `fieldBounds.canonical.json` (SHA-256 parity test
 * locks them together; CI fails on drift).
 */

export const CORRECTABLE_FIELDS = new Set<string>([
  'days_to_germinate_min','days_to_germinate_max',
  'days_to_maturity_min','days_to_maturity_max',
  'soil_temp_min_f','soil_temp_max_f',
  'seed_depth_inches','plant_spacing_inches','row_spacing_inches',
  'hardiness_zone_min','hardiness_zone_max','viability_years',
  'sun_requirement','frost_tolerance','sow_method','life_cycle',
  'scientific_name','common_name','variety','company','instructions',
]);

/**
 * Subset of `CORRECTABLE_FIELDS` whose values may bypass human review when
 * every gate in `decideCorrectionOutcome` passes. Numeric + enum only —
 * free-text fields (instructions, common_name, variety, scientific_name,
 * company) always queue for human review regardless of AI confidence.
 */
export const AUTO_APPLY_FIELDS = new Set<string>([
  'days_to_germinate_min','days_to_germinate_max',
  'days_to_maturity_min','days_to_maturity_max',
  'soil_temp_min_f','soil_temp_max_f',
  'seed_depth_inches','plant_spacing_inches','row_spacing_inches',
  'hardiness_zone_min','hardiness_zone_max','viability_years',
  'sun_requirement','frost_tolerance','sow_method','life_cycle',
]);

export const SANITY_BOUNDS: Record<string, { min: number; max: number }> = {
  days_to_germinate_min:  { min: 1,    max: 60   },
  days_to_germinate_max:  { min: 1,    max: 90   },
  days_to_maturity_min:   { min: 5,    max: 365  },
  days_to_maturity_max:   { min: 5,    max: 365  },
  soil_temp_min_f:        { min: 20,   max: 110  },
  soil_temp_max_f:        { min: 20,   max: 110  },
  seed_depth_inches:      { min: 0.05, max: 9.99 },  // NUMERIC(3,2) hard cap
  plant_spacing_inches:   { min: 1,    max: 240  },
  row_spacing_inches:     { min: 1,    max: 240  },
  hardiness_zone_min:     { min: 1,    max: 13   },
  hardiness_zone_max:     { min: 1,    max: 13   },
  viability_years:        { min: 1,    max: 20   },
};

/**
 * Strict-but-in-bounds thresholds that force human review. A value above
 * the suspect threshold passes the sanity bounds (so the user can submit
 * it) but `requires_human: true` short-circuits auto_apply.
 */
export const SUSPECT_THRESHOLDS: Record<string, number> = {
  seed_depth_inches: 3,      // > 3 in is botanically rare; likely cm
  plant_spacing_inches: 96,  // > 8 ft for any vegetable is suspect
  row_spacing_inches: 96,
};

export const ENUM_VALUES: Record<string, readonly string[]> = {
  sun_requirement: ['full','partial','shade'],
  frost_tolerance: ['tender','half_hardy','hardy'],
  sow_method:      ['direct','transplant','either'],
  life_cycle:      ['annual','biennial','perennial'],
};

const INTEGER_FIELDS = new Set<string>([
  'days_to_germinate_min','days_to_germinate_max',
  'days_to_maturity_min','days_to_maturity_max',
  'soil_temp_min_f','soil_temp_max_f',
  'plant_spacing_inches','row_spacing_inches',
  'hardiness_zone_min','hardiness_zone_max','viability_years',
]);

const NUMERIC_FIELDS = new Set<string>(['seed_depth_inches']);

const FREE_TEXT_FIELDS = new Set<string>([
  'scientific_name','common_name','variety','company','instructions',
]);

export type ValidationOK = {
  ok: true;
  normalized: string | number;
  /** True when the value passes bounds but should still queue for human review. */
  requires_human?: boolean;
};
export type ValidationFail = {
  ok: false;
  reason: string;
  bounds_hint: string;
};

/**
 * Validate + normalize a single field value. Returns a discriminated
 * union so callers can branch on `ok`. Numeric strings are coerced;
 * enum values are compared case-insensitively then normalized to the
 * canonical lowercase form.
 */
export function validateFieldValue(
  field: string,
  raw: string | number,
): ValidationOK | ValidationFail {
  if (!CORRECTABLE_FIELDS.has(field)) {
    return { ok: false, reason: 'unknown_field', bounds_hint: `${field} is not user-correctable` };
  }

  // Enum fields — case-insensitive match against ENUM_VALUES.
  const enumOpts = ENUM_VALUES[field];
  if (enumOpts) {
    if (typeof raw !== 'string') {
      return {
        ok: false,
        reason: 'invalid_enum',
        bounds_hint: `valid values: ${enumOpts.join(', ')}`,
      };
    }
    const normalized = raw.trim().toLowerCase();
    if (!enumOpts.includes(normalized)) {
      return {
        ok: false,
        reason: 'invalid_enum',
        bounds_hint: `valid values: ${enumOpts.join(', ')}`,
      };
    }
    return { ok: true, normalized };
  }

  // Numeric fields.
  const bounds = SANITY_BOUNDS[field];
  if (bounds) {
    let value: number;
    if (typeof raw === 'number') {
      value = raw;
    } else if (typeof raw === 'string') {
      const trimmed = raw.trim();
      // Require the entire string to be a parseable number — no trailing
      // prose. Catches "60.5; DROP TABLE..." style payloads that
      // parseInt/parseFloat would silently truncate.
      const NUMERIC_FULL = /^-?\d+(?:\.\d+)?$/;
      if (!NUMERIC_FULL.test(trimmed)) {
        return {
          ok: false,
          reason: 'not_a_number',
          bounds_hint: describeBounds(field),
        };
      }
      const parsed = INTEGER_FIELDS.has(field) ? parseFloat(trimmed) : parseFloat(trimmed);
      if (!Number.isFinite(parsed)) {
        return {
          ok: false,
          reason: 'not_a_number',
          bounds_hint: describeBounds(field),
        };
      }
      value = parsed;
    } else {
      return {
        ok: false,
        reason: 'not_a_number',
        bounds_hint: describeBounds(field),
      };
    }
    if (INTEGER_FIELDS.has(field) && !Number.isInteger(value)) {
      return {
        ok: false,
        reason: 'not_an_integer',
        bounds_hint: describeBounds(field),
      };
    }
    if (value < bounds.min || value > bounds.max) {
      return {
        ok: false,
        reason: 'out_of_bounds',
        bounds_hint: describeBounds(field),
      };
    }
    const result: ValidationOK = { ok: true, normalized: value };
    const suspectAt = SUSPECT_THRESHOLDS[field];
    if (suspectAt !== undefined && value > suspectAt) {
      result.requires_human = true;
    }
    return result;
  }

  // Free-text fields — accept any non-empty string within an upper-bound length.
  if (FREE_TEXT_FIELDS.has(field)) {
    if (typeof raw !== 'string') {
      return { ok: false, reason: 'not_a_string', bounds_hint: 'text expected' };
    }
    const trimmed = raw.trim();
    if (trimmed.length < 1) {
      return { ok: false, reason: 'empty', bounds_hint: 'value must not be empty' };
    }
    if (trimmed.length > 2000) {
      return { ok: false, reason: 'too_long', bounds_hint: 'value must be 2000 characters or fewer' };
    }
    return { ok: true, normalized: trimmed, requires_human: true };
  }

  return { ok: false, reason: 'unknown_field', bounds_hint: `${field} is not user-correctable` };
}

/** Human-readable bounds string for `field` (used in error responses and iOS hints). */
export function describeBounds(field: string): string {
  const enumOpts = ENUM_VALUES[field];
  if (enumOpts) return `valid values: ${enumOpts.join(', ')}`;
  const bounds = SANITY_BOUNDS[field];
  if (bounds) {
    if (NUMERIC_FIELDS.has(field)) {
      return `typical range: ${bounds.min}–${bounds.max}`;
    }
    return `typical range: ${bounds.min}–${bounds.max}`;
  }
  if (FREE_TEXT_FIELDS.has(field)) return 'free-form text up to 2000 characters';
  return `${field} is not user-correctable`;
}

/**
 * Serializable snapshot of the constants above. Exported for SHA-256
 * parity with the iOS mirror — tests compare the hash of this object's
 * canonical JSON encoding against `fieldBounds.canonical.json`.
 */
export function fieldBoundsSnapshot(): {
  correctableFields: string[];
  autoApplyFields: string[];
  sanityBounds: Record<string, { min: number; max: number }>;
  suspectThresholds: Record<string, number>;
  enumValues: Record<string, string[]>;
} {
  return {
    correctableFields: [...CORRECTABLE_FIELDS].sort(),
    autoApplyFields: [...AUTO_APPLY_FIELDS].sort(),
    sanityBounds: Object.fromEntries(
      Object.entries(SANITY_BOUNDS)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, { min: v.min, max: v.max }]),
    ),
    suspectThresholds: Object.fromEntries(
      Object.entries(SUSPECT_THRESHOLDS).sort(([a], [b]) => a.localeCompare(b)),
    ),
    enumValues: Object.fromEntries(
      Object.entries(ENUM_VALUES)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, [...v]]),
    ),
  };
}
