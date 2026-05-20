// Deterministic planting-window rule engine. Pure — currentYear is
// passed in, no clock or I/O. The AI fallback (aiFallback.ts) covers
// low-confidence cases; this engine handles everything well-structured.

export interface CatalogHorticultural {
  frost_tolerance: 'tender' | 'half_hardy' | 'hardy' | null;
  sow_method: 'direct' | 'transplant' | 'either' | null;
  soil_temp_min_f: number | null;
  soil_temp_max_f: number | null;
  days_to_germinate_min: number | null;
  days_to_germinate_max: number | null;
  days_to_maturity_min: number | null;
  days_to_maturity_max: number | null;
  hardiness_zone_min: number | null;
  hardiness_zone_max: number | null;
}

export interface HouseholdLocation {
  usdaZone: string;      // '7a'
  avgLastFrost: string;  // 'MM-DD'
  avgFirstFrost: string; // 'MM-DD'
}

export interface RuleBaseline {
  windowStart: string | null; // 'YYYY-MM-DD'
  windowEnd: string | null;
  indoorStart: string | null;
  indoorEnd: string | null;
  confidence: number;         // 0..1
  inputsUsed: string[];
}

// Below this, the route/worker calls the AI fallback instead of trusting
// the rule output. Tunable — locked by engine.test.ts (cf. decideCatalogStatus).
export const CONFIDENCE_THRESHOLD = 0.6;

const MATURITY_BUFFER_DAYS = 14; // safety margin before first frost
const INDOOR_START_MIN_DAYS = 42; // 6 weeks before transplant-out
const INDOOR_START_MAX_DAYS = 56; // 8 weeks before transplant-out

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}
function frostDate(year: number, mmdd: string): Date {
  const [m, d] = mmdd.split('-').map(Number);
  return new Date(Date.UTC(year, m - 1, d));
}

export function computeRuleBaseline(
  cat: CatalogHorticultural,
  loc: HouseholdLocation,
  currentYear: number,
): RuleBaseline {
  const inputsUsed: string[] = ['avg_last_frost', 'avg_first_frost'];
  const lastFrost = frostDate(currentYear, loc.avgLastFrost);
  const firstFrost = frostDate(currentYear, loc.avgFirstFrost);

  // Earliest outdoor plant date by frost tolerance.
  let earliestOffset = 0; // days relative to last frost
  if (cat.frost_tolerance === 'half_hardy') earliestOffset = -7;
  else if (cat.frost_tolerance === 'hardy') earliestOffset = -28;
  if (cat.frost_tolerance) inputsUsed.push('frost_tolerance');
  const earliest = addDays(lastFrost, earliestOffset);

  // Latest plant date: must mature + buffer before first frost.
  const maturity = cat.days_to_maturity_max ?? cat.days_to_maturity_min;
  let latest: Date | null = null;
  if (maturity != null) {
    inputsUsed.push('days_to_maturity_max');
    latest = addDays(firstFrost, -(maturity + MATURITY_BUFFER_DAYS));
  }

  if (cat.sow_method) inputsUsed.push('sow_method');
  if (cat.soil_temp_min_f != null) inputsUsed.push('soil_temp_min_f');
  if (cat.hardiness_zone_min != null && cat.hardiness_zone_max != null) {
    inputsUsed.push('hardiness_zone');
  }

  // Indoor-start window for transplant varieties.
  let indoorStart: string | null = null;
  let indoorEnd: string | null = null;
  if (cat.sow_method === 'transplant') {
    indoorStart = fmt(addDays(earliest, -INDOOR_START_MAX_DAYS));
    indoorEnd = fmt(addDays(earliest, -INDOOR_START_MIN_DAYS));
  }

  // Confidence: full data = 1.0, each missing key input subtracts.
  let confidence = 1.0;
  // frost_tolerance is the single most load-bearing input — it sets the
  // earliest-plant offset directly — so its absence is penalized hardest.
  // 0.25 (not 0.20) also keeps "missing frost_tolerance + soil temp" at
  // 0.55, cleanly below CONFIDENCE_THRESHOLD rather than exactly on it.
  if (cat.frost_tolerance == null) confidence -= 0.25;
  if (cat.soil_temp_min_f == null) confidence -= 0.20;
  if (cat.sow_method == null) confidence -= 0.15;
  if (cat.days_to_maturity_max == null && cat.days_to_maturity_min == null) confidence -= 0.10;
  const zone = parseInt(loc.usdaZone, 10);
  if ((cat.hardiness_zone_min == null || cat.hardiness_zone_max == null) &&
      (zone < 3 || zone > 10)) {
    confidence -= 0.10;
  }
  confidence = Math.max(0, Math.round(confidence * 100) / 100);

  // No window at all without a latest date.
  const windowStart = latest ? fmt(earliest) : null;
  const windowEnd = latest ? fmt(latest) : null;

  return { windowStart, windowEnd, indoorStart, indoorEnd, confidence, inputsUsed };
}
