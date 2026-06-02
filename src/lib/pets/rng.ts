// Deterministic plant-pet rarity + creature-kind picker.
//
// Algorithm (locked — must match byte-for-byte across server TS and any
// Swift verifier; see spec → "RNG seeding + rarity system"):
//
//   1. pet_seed = sha256(planting_event_id_utf8) → 64-char lowercase hex.
//   2. Initial xorshift64* state = LOW 64 bits of the hash. If 0, force
//      0x9E3779B97F4A7C15.
//   3. First nextUnit() call → rarity bucket via half-open intervals
//        [0,0.60) common · [0.60,0.85) uncommon · [0.85,0.97) rare
//        [0.97,0.998) legendary · [0.998,1.0) mythical
//   4. Second nextUnit() call (continues the SAME state — no re-seed)
//      → creature kind, weighted within the rarity tier. Seasonal bias
//      (3× weight) applies ONLY to common + uncommon tiers; rare /
//      legendary / mythical are uniform.
//
// Pure module — no Date.now() reads, no DB. The caller passes `season`
// when relevant; if omitted, no seasonal multiplier applies.

import { createHash } from 'node:crypto';
import { POOLS, type CreatureEntry, type PetRarity, type PetSeason } from './bestiary';

// ── Hash → seed (TEXT we store in planting_events.pet_seed) ──────────────

export function computePetSeed(plantingEventId: string): string {
  return createHash('sha256').update(plantingEventId, 'utf8').digest('hex');
}

// ── xorshift64* over BigInt (wrapping 64-bit arithmetic) ─────────────────

const MASK_64 = (1n << 64n) - 1n;
const FALLBACK_STATE = 0x9e3779b97f4a7c15n;
const MULT = 0x2545f4914f6cdd1dn;
const POW_2_53 = 1n << 53n;
const POW_2_53_NUM = Number(POW_2_53); // exactly representable

function seedFromHex(petSeedHex: string): bigint {
  // Take the LOW 64 bits of the 256-bit hash (= the last 16 hex chars).
  // Spec: "the low 64 bits of the hash are used as the initial state".
  const low = petSeedHex.slice(-16);
  let state = BigInt('0x' + low) & MASK_64;
  if (state === 0n) state = FALLBACK_STATE;
  return state;
}

interface Rng {
  next(): bigint;
  nextUnit(): number;
}

function makeRng(petSeedHex: string): Rng {
  let state = seedFromHex(petSeedHex);
  return {
    next(): bigint {
      // state ^= state >> 12
      state = (state ^ (state >> 12n)) & MASK_64;
      // state ^= state << 25  (wrap at 64 bits)
      state = (state ^ (state << 25n)) & MASK_64;
      // state ^= state >> 27
      state = (state ^ (state >> 27n)) & MASK_64;
      // (state * 0x2545F4914F6CDD1D) mod 2^64
      return (state * MULT) & MASK_64;
    },
    nextUnit(): number {
      // High 53 bits of next(), divided by 2^53 → [0, 1).
      const v = this.next() >> 11n;
      return Number(v) / POW_2_53_NUM;
    },
  };
}

// ── Rarity roll ───────────────────────────────────────────────────────────

// Bucket boundaries (half-open intervals). Order matters: walks low→high.
const RARITY_BUCKETS: ReadonlyArray<{ ceiling: number; tier: PetRarity }> = [
  { ceiling: 0.6,   tier: 'common' },
  { ceiling: 0.85,  tier: 'uncommon' },
  { ceiling: 0.97,  tier: 'rare' },
  { ceiling: 0.998, tier: 'legendary' },
  { ceiling: 1.0,   tier: 'mythical' },
];

function bucketRarity(r: number): PetRarity {
  for (const { ceiling, tier } of RARITY_BUCKETS) {
    if (r < ceiling) return tier;
  }
  // r ∈ [0, 1) by construction — this is unreachable. Guard the boundary.
  return 'mythical';
}

export function rollRarity(petSeedHex: string): PetRarity {
  const rng = makeRng(petSeedHex);
  return bucketRarity(rng.nextUnit());
}

// ── Creature-kind roll ────────────────────────────────────────────────────

const SEASONABLE_TIERS = new Set<PetRarity>(['common', 'uncommon']);

function weightOf(entry: CreatureEntry, season: PetSeason | undefined): number {
  if (
    season !== undefined &&
    SEASONABLE_TIERS.has(entry.tier) &&
    entry.season === season
  ) {
    return 3;
  }
  return 1;
}

// Sorted pool for a tier. Sort by `kind` ASC for stable indexing — adding
// a new (alphabetically-late) creature must not reshuffle historic spawns.
function sortedPool(rarity: PetRarity): ReadonlyArray<CreatureEntry> {
  return [...POOLS[rarity]].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

function pickKindFromTier(
  rng: Rng,
  rarity: PetRarity,
  season: PetSeason | undefined,
): string {
  const pool = sortedPool(rarity);
  const weights = pool.map((e) => weightOf(e, season));
  const total = weights.reduce((a, b) => a + b, 0);

  // Spec walks the candidate list "subtracting each weight from `pick`;
  // first kind where `pick < 0` is chosen." `pick` starts as
  // `nextUnit() * w_total`, which can equal 0 (never `w_total` since
  // nextUnit() ∈ [0, 1)). We mirror the spec semantics literally.
  let pick = rng.nextUnit() * total;
  for (let i = 0; i < pool.length; i++) {
    pick -= weights[i];
    if (pick < 0) return pool[i].kind;
  }
  // Floating-point safety net — should never hit with a well-behaved rng.
  return pool[pool.length - 1].kind;
}

export function rollCreatureKind(
  petSeedHex: string,
  rarity: PetRarity,
  season?: PetSeason,
): string {
  const rng = makeRng(petSeedHex);
  // Spec: same xorshift state advances; rarity consumes the first
  // nextUnit() call, creature-kind consumes the second.
  rng.nextUnit();
  return pickKindFromTier(rng, rarity, season);
}

// ── Season-from-month helper (UTC only in v1) ─────────────────────────────

export function seasonFromUtcMonth(month1Indexed: number): PetSeason {
  // 1=Jan ... 12=Dec
  if (month1Indexed >= 3 && month1Indexed <= 5) return 'spring';
  if (month1Indexed >= 6 && month1Indexed <= 8) return 'summer';
  if (month1Indexed >= 9 && month1Indexed <= 11) return 'autumn';
  return 'winter';
}

export function seasonFromEpochMs(epochMs: number): PetSeason {
  const d = new Date(epochMs);
  return seasonFromUtcMonth(d.getUTCMonth() + 1);
}
