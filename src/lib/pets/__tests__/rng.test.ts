import { describe, it, expect } from 'vitest';
import {
  computePetSeed,
  rollRarity,
  rollCreatureKind,
  seasonFromUtcMonth,
} from '../rng';
import { POOLS, BESTIARY, type PetRarity, type PetSeason } from '../bestiary';

// Small helper: deterministic mulberry32 for generating planting-event ids
// used as RNG input. We need *some* spread of seed values for distribution
// tests, but the property we're verifying is in `rollRarity` itself — so
// any deterministic stream of input ids works.
function makeIdStream(label: string): () => string {
  let i = 0;
  return () => `${label}-${(i++).toString(36)}`;
}

describe('computePetSeed', () => {
  it('produces a 64-character lowercase hex string', () => {
    const seed = computePetSeed('planting-event-abc');
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', () => {
    const a = computePetSeed('event-1');
    const b = computePetSeed('event-1');
    expect(a).toBe(b);
  });

  it('differs across inputs', () => {
    const a = computePetSeed('event-1');
    const b = computePetSeed('event-2');
    expect(a).not.toBe(b);
  });
});

describe('rollRarity + rollCreatureKind — determinism', () => {
  it('same seed → same rarity', () => {
    const seed = computePetSeed('planting-event-xyz');
    expect(rollRarity(seed)).toBe(rollRarity(seed));
  });

  it('same seed → same creature kind (no season)', () => {
    const seed = computePetSeed('planting-event-xyz');
    const rarity = rollRarity(seed);
    expect(rollCreatureKind(seed, rarity)).toBe(rollCreatureKind(seed, rarity));
  });

  it('same seed + season → same creature kind', () => {
    const seed = computePetSeed('planting-event-spring');
    const rarity = rollRarity(seed);
    const a = rollCreatureKind(seed, rarity, 'spring');
    const b = rollCreatureKind(seed, rarity, 'spring');
    expect(a).toBe(b);
  });

  it('1000-input sweep is stable across two calls', () => {
    const nextId = makeIdStream('sweep');
    for (let i = 0; i < 1000; i++) {
      const id = nextId();
      const seed = computePetSeed(id);
      const r1 = rollRarity(seed);
      const r2 = rollRarity(seed);
      const k1 = rollCreatureKind(seed, r1);
      const k2 = rollCreatureKind(seed, r2);
      expect(r1).toBe(r2);
      expect(k1).toBe(k2);
    }
  });
});

describe('rollRarity — distribution', () => {
  it('over 10 000 rolls, tier proportions are within ±2pp of nominal', () => {
    const counts: Record<PetRarity, number> = {
      common: 0, uncommon: 0, rare: 0, legendary: 0, mythical: 0,
    };
    const N = 10_000;
    const nextId = makeIdStream('dist');
    for (let i = 0; i < N; i++) {
      const seed = computePetSeed(nextId());
      counts[rollRarity(seed)] += 1;
    }

    const pct = (n: number) => (n / N) * 100;
    // ±2pp band for common/uncommon/rare. legendary (2.8%) and mythical
    // (0.2%) have wider absolute bands per spec — assert legendary within
    // ±2pp too (still tight enough), and mythical as a count band.
    expect(Math.abs(pct(counts.common)    - 60.0)).toBeLessThan(2);
    expect(Math.abs(pct(counts.uncommon)  - 25.0)).toBeLessThan(2);
    expect(Math.abs(pct(counts.rare)      - 12.0)).toBeLessThan(2);
    expect(Math.abs(pct(counts.legendary) -  2.8)).toBeLessThan(2);
    // Mythical at 0.2% over 10k → expected 20. ±2pp = ±200 is meaningless;
    // assert it's in a sane count band instead.
    expect(counts.mythical).toBeGreaterThanOrEqual(5);
    expect(counts.mythical).toBeLessThanOrEqual(60);
  });
});

describe('bestiary — pool invariants', () => {
  it('every tier pool is non-empty', () => {
    for (const tier of Object.keys(POOLS) as PetRarity[]) {
      expect(POOLS[tier].length).toBeGreaterThan(0);
    }
  });

  it('catalog totals match the spec (10+6+4+4+4 base + 4+4 seasonal = 36)', () => {
    expect(BESTIARY.length).toBe(36);
    expect(POOLS.common.length).toBe(14);
    expect(POOLS.uncommon.length).toBe(10);
    expect(POOLS.rare.length).toBe(4);
    expect(POOLS.legendary.length).toBe(4);
    expect(POOLS.mythical.length).toBe(4);
  });

  it('every kind matches ^[a-z]+(_[a-z]+)*$', () => {
    const re = /^[a-z]+(_[a-z]+)*$/;
    for (const e of BESTIARY) {
      expect(e.kind, e.kind).toMatch(re);
    }
  });

  it('every kind is unique across the catalog', () => {
    const seen = new Set<string>();
    for (const e of BESTIARY) {
      expect(seen.has(e.kind), e.kind).toBe(false);
      seen.add(e.kind);
    }
  });

  it('no rare/legendary/mythical entry has a season tag', () => {
    for (const tier of ['rare', 'legendary', 'mythical'] as PetRarity[]) {
      for (const e of POOLS[tier]) {
        expect(e.season, `${e.kind} should have no season`).toBeUndefined();
      }
    }
  });

  it('only mythical entries carry a flourish description', () => {
    for (const e of BESTIARY) {
      if (e.tier === 'mythical') {
        expect(e.flourish, e.kind).toBeTruthy();
      } else {
        expect(e.flourish, e.kind).toBeUndefined();
      }
    }
  });
});

describe('rollCreatureKind — seasonal bias', () => {
  // Sanity: spring-tagged common is `robin`. With season='spring', the
  // `robin` frequency should be measurably higher than with season
  // unset / non-spring season.
  it('shifts common-tier distribution toward in-season kinds', () => {
    // Collect ALL common-tier rolls (regardless of true rarity) so we have
    // enough samples in a reasonable test runtime. We do this by picking
    // a fixed "common" rarity and varying the seed.
    const N = 5000;
    const nextId = makeIdStream('seasonal');

    const countKind = (season: PetSeason | undefined): Record<string, number> => {
      const out: Record<string, number> = {};
      for (let i = 0; i < N; i++) {
        const seed = computePetSeed(nextId());
        const kind = rollCreatureKind(seed, 'common', season);
        out[kind] = (out[kind] ?? 0) + 1;
      }
      return out;
    };

    const noSeason = countKind(undefined);
    const spring   = countKind('spring');
    const autumn   = countKind('autumn');

    // robin (spring-tagged): spring frequency should exceed autumn freq.
    expect(spring['robin'] ?? 0).toBeGreaterThan(noSeason['robin'] ?? 0);
    expect((spring['robin'] ?? 0) / Math.max(1, (autumn['robin'] ?? 0))).toBeGreaterThan(1.5);

    // harvest_mouse (autumn-tagged): autumn frequency should exceed spring.
    expect(autumn['harvest_mouse'] ?? 0).toBeGreaterThan(spring['harvest_mouse'] ?? 0);
  });

  it('does NOT vary distribution for rare-tier (seasonal bias scope = common+uncommon only)', () => {
    const N = 4000;
    const nextId = makeIdStream('rare-season');

    const countKind = (season: PetSeason): Record<string, number> => {
      const out: Record<string, number> = {};
      for (let i = 0; i < N; i++) {
        const seed = computePetSeed(nextId());
        const kind = rollCreatureKind(seed, 'rare', season);
        out[kind] = (out[kind] ?? 0) + 1;
      }
      return out;
    };

    const spring = countKind('spring');
    const autumn = countKind('autumn');

    // Each rare creature should appear at roughly the same rate in both
    // seasons. We tolerate statistical noise — assert max ratio < 1.3.
    for (const entry of POOLS.rare) {
      const s = spring[entry.kind] ?? 0;
      const a = autumn[entry.kind] ?? 0;
      const ratio = Math.max(s, a) / Math.max(1, Math.min(s, a));
      expect(ratio, `${entry.kind}: spring=${s}, autumn=${a}`).toBeLessThan(1.3);
    }
  });
});

describe('rollCreatureKind — pool correctness', () => {
  it('returns a kind that belongs to the rolled rarity tier', () => {
    const nextId = makeIdStream('pool');
    for (let i = 0; i < 200; i++) {
      const seed = computePetSeed(nextId());
      const rarity = rollRarity(seed);
      const kind = rollCreatureKind(seed, rarity);
      const pool = POOLS[rarity];
      expect(pool.some((e) => e.kind === kind), `rarity=${rarity}, kind=${kind}`).toBe(true);
    }
  });
});

describe('seasonFromUtcMonth', () => {
  it('maps the spec season buckets exactly', () => {
    expect(seasonFromUtcMonth(1)).toBe('winter');
    expect(seasonFromUtcMonth(2)).toBe('winter');
    expect(seasonFromUtcMonth(3)).toBe('spring');
    expect(seasonFromUtcMonth(4)).toBe('spring');
    expect(seasonFromUtcMonth(5)).toBe('spring');
    expect(seasonFromUtcMonth(6)).toBe('summer');
    expect(seasonFromUtcMonth(7)).toBe('summer');
    expect(seasonFromUtcMonth(8)).toBe('summer');
    expect(seasonFromUtcMonth(9)).toBe('autumn');
    expect(seasonFromUtcMonth(10)).toBe('autumn');
    expect(seasonFromUtcMonth(11)).toBe('autumn');
    expect(seasonFromUtcMonth(12)).toBe('winter');
  });
});
