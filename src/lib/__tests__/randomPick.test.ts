import { describe, it, expect } from 'vitest';
import { pickWeightedSeed, type SeedForPick, type RandomFn } from '../randomPick';

describe('pickWeightedSeed (linear-by-age, null-as-median)', () => {
  it('returns null for an empty list', () => {
    expect(pickWeightedSeed([], 2026)).toBeNull();
  });

  it('always returns the only seed when list has one item', () => {
    const seeds: SeedForPick[] = [{ id: 's1', year_packed: 2024 }];
    expect(pickWeightedSeed(seeds, 2026, () => 0)).toEqual(seeds[0]);
    expect(pickWeightedSeed(seeds, 2026, () => 0.99999)).toEqual(seeds[0]);
  });

  it('weights an older packet proportionally higher than a newer one', () => {
    // currentYear = 2026
    //   fresh:  weight = max(1, 2026 - 2026) = 1
    //   old:    weight = max(1, 2026 - 2022) = 4
    //   total = 5, so old's range is rng() ∈ [0.2, 1.0)  → 80% of the unit interval.
    const seeds: SeedForPick[] = [
      { id: 'fresh', year_packed: 2026 },
      { id: 'old', year_packed: 2022 },
    ];
    // rng = 0.0 → cumulative weight 1 hits 'fresh' first
    expect(pickWeightedSeed(seeds, 2026, () => 0.0)?.id).toBe('fresh');
    // rng = 0.19 → 0.19 * 5 = 0.95, still in 'fresh' range
    expect(pickWeightedSeed(seeds, 2026, () => 0.19)?.id).toBe('fresh');
    // rng = 0.21 → 0.21 * 5 = 1.05, falls into 'old'
    expect(pickWeightedSeed(seeds, 2026, () => 0.21)?.id).toBe('old');
    // rng = 0.99 → 4.95, still 'old'
    expect(pickWeightedSeed(seeds, 2026, () => 0.99)?.id).toBe('old');
  });

  it('treats null year_packed as weight 2 (median)', () => {
    // fresh weight = 1, unknown = 2; total = 3.
    // rng <= 1/3 → fresh; otherwise unknown.
    const seeds: SeedForPick[] = [
      { id: 'fresh', year_packed: 2026 },
      { id: 'unknown', year_packed: null },
    ];
    expect(pickWeightedSeed(seeds, 2026, () => 0.0)?.id).toBe('fresh');
    expect(pickWeightedSeed(seeds, 2026, () => 0.5)?.id).toBe('unknown');
  });

  it('over many rolls, the empirical distribution matches expected weights', () => {
    const seeds: SeedForPick[] = [
      { id: 'fresh', year_packed: 2026 },  // weight 1
      { id: 'mid', year_packed: 2024 },    // weight 2
      { id: 'old', year_packed: 2022 },    // weight 4
    ];
    // Use a deterministic LCG so the test is reproducible.
    let state = 1;
    const rng: RandomFn = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    const counts: Record<string, number> = { fresh: 0, mid: 0, old: 0 };
    const N = 7000;
    for (let i = 0; i < N; i++) {
      const pick = pickWeightedSeed(seeds, 2026, rng);
      if (pick) counts[pick.id]++;
    }
    // Expected ratios: fresh ≈ 1/7, mid ≈ 2/7, old ≈ 4/7.
    expect(counts.fresh / N).toBeCloseTo(1 / 7, 1);
    expect(counts.mid / N).toBeCloseTo(2 / 7, 1);
    expect(counts.old / N).toBeCloseTo(4 / 7, 1);
  });
});
