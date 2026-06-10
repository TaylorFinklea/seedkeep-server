import { describe, it, expect } from 'vitest';
import { computeRuleBaseline, CONFIDENCE_THRESHOLD } from '../engine';
import type { CatalogHorticultural, HouseholdLocation } from '../engine';

const ZONE_7A: HouseholdLocation = {
  usdaZone: '7a', avgLastFrost: '04-10', avgFirstFrost: '11-01',
};

const FULL_TENDER_DIRECT: CatalogHorticultural = {
  frost_tolerance: 'tender', sow_method: 'direct',
  soil_temp_min_f: 60, soil_temp_max_f: 95,
  days_to_germinate_min: 7, days_to_germinate_max: 14,
  days_to_maturity_min: 60, days_to_maturity_max: 80,
  hardiness_zone_min: 3, hardiness_zone_max: 11,
};

describe('computeRuleBaseline', () => {
  it('tender direct-sow opens at last frost', () => {
    const b = computeRuleBaseline(FULL_TENDER_DIRECT, ZONE_7A, 2026);
    expect(b.windowStart).toBe('2026-04-10');
    expect(b.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
  });

  it('hardy direct-sow opens four weeks before last frost', () => {
    const b = computeRuleBaseline(
      { ...FULL_TENDER_DIRECT, frost_tolerance: 'hardy' }, ZONE_7A, 2026,
    );
    expect(b.windowStart).toBe('2026-03-13'); // 04-10 minus 28 days
  });

  it('latest plant date leaves maturity + 14d buffer before first frost', () => {
    const b = computeRuleBaseline(FULL_TENDER_DIRECT, ZONE_7A, 2026);
    // 11-01 minus 80 days maturity minus 14 buffer = 2026-07-30 (exclusive arithmetic)
    expect(b.windowEnd).toBe('2026-07-30');
  });

  it('transplant variety gets an indoor-start window', () => {
    const b = computeRuleBaseline(
      { ...FULL_TENDER_DIRECT, sow_method: 'transplant' }, ZONE_7A, 2026,
    );
    expect(b.indoorStart).not.toBeNull();
    expect(b.indoorEnd).not.toBeNull();
  });

  it('missing frost_tolerance and soil temp drops confidence below threshold', () => {
    const b = computeRuleBaseline(
      { ...FULL_TENDER_DIRECT, frost_tolerance: null, soil_temp_min_f: null },
      ZONE_7A, 2026,
    );
    expect(b.confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
  });

  it('records which inputs contributed', () => {
    const b = computeRuleBaseline(FULL_TENDER_DIRECT, ZONE_7A, 2026);
    expect(b.inputsUsed).toContain('frost_tolerance');
    expect(b.inputsUsed).toContain('avg_last_frost');
  });

  it('inverted window (season too short): returns null window and drops confidence below threshold', () => {
    // Zone 3: last frost ~May-28, first frost ~Sep-12. A tender 110-day crop:
    // latest = Sep-12 - (110+14) = May-11, which is before earliest = May-28.
    const ZONE_3: HouseholdLocation = {
      usdaZone: '3', avgLastFrost: '05-28', avgFirstFrost: '09-12',
    };
    const LONG_TENDER: CatalogHorticultural = {
      ...FULL_TENDER_DIRECT,
      days_to_maturity_min: 100,
      days_to_maturity_max: 110,
    };
    const b = computeRuleBaseline(LONG_TENDER, ZONE_3, 2026);
    expect(b.windowStart).toBeNull();
    expect(b.windowEnd).toBeNull();
    expect(b.confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
  });

  it('valid window passes unchanged when latest >= earliest', () => {
    // Confirm the guard does not affect normal seasons.
    const b = computeRuleBaseline(FULL_TENDER_DIRECT, ZONE_7A, 2026);
    expect(b.windowStart).not.toBeNull();
    expect(b.windowEnd).not.toBeNull();
    expect(b.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
  });
});
