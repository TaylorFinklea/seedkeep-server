// Plant-pet companion catalog. The single source of truth for the
// 5-tier rarity system + creature roster. Imported by `rng.ts` for
// the deterministic creature pick and by future surfaces that need
// the display name / static gold-ink flourish description.
//
// Catalog totals (Phase 5.1.0 spec):
//   common:    10 base + 4 seasonal = 14
//   uncommon:   6 base + 4 seasonal = 10
//   rare:       4 (no seasonal)
//   legendary:  4 (no seasonal)
//   mythical:   4 (no seasonal — each ships with a `flourish` string)
//   -----------------------------------------------------------------
//   TOTAL:     36 entries
//
// Locked rules (see spec → Bestiary → "Identifier rules"):
//   - Every `kind` is permanent contract once a row is stamped on a
//     `planting_events.pet_creature_kind` column in production.
//   - Adding entries is additive (sort-stable in `rng.ts`).
//   - Removing entries is forbidden; deprecate by flagging future
//     deprecation, never by deletion — existing pets must still render.
//   - `kind` format: ^[a-z]+(_[a-z]+)*$  (lowercase snake_case ASCII).
//   - Only common + uncommon entries carry a `season` tag (3× weight in
//     matching season). Rare / legendary / mythical never seasonal.

export type PetRarity = 'common' | 'uncommon' | 'rare' | 'legendary' | 'mythical';

export type PetSeason = 'spring' | 'summer' | 'autumn' | 'winter';

export interface CreatureEntry {
  kind: string;
  displayName: string;
  tier: PetRarity;
  season?: PetSeason;
  // Mythical entries only — describes the static gold-ink flourish
  // (no animation in v1). Undefined for non-mythical tiers.
  flourish?: string;
}

// ── Common (10 base + 4 seasonal = 14) ────────────────────────────────────

const COMMON: ReadonlyArray<CreatureEntry> = [
  { kind: 'ant',            displayName: 'Ant',           tier: 'common' },
  { kind: 'brown_moth',     displayName: 'Brown Moth',    tier: 'common' },
  { kind: 'cicada',         displayName: 'Cicada',        tier: 'common', season: 'summer' },
  { kind: 'field_mouse',    displayName: 'Field Mouse',   tier: 'common' },
  { kind: 'garden_worm',    displayName: 'Garden Worm',   tier: 'common' },
  { kind: 'harvest_mouse',  displayName: 'Harvest Mouse', tier: 'common', season: 'autumn' },
  { kind: 'ladybug',        displayName: 'Ladybug',       tier: 'common' },
  { kind: 'pillbug',        displayName: 'Pillbug',       tier: 'common' },
  { kind: 'robin',          displayName: 'Spring Robin',  tier: 'common', season: 'spring' },
  { kind: 'slug',           displayName: 'Slug',          tier: 'common' },
  { kind: 'snail',          displayName: 'Snail',         tier: 'common' },
  { kind: 'sparrow',        displayName: 'Sparrow',       tier: 'common' },
  { kind: 'weevil',         displayName: 'Weevil',        tier: 'common' },
  { kind: 'winter_wren',    displayName: 'Winter Wren',   tier: 'common', season: 'winter' },
];

// ── Uncommon (6 base + 4 seasonal = 10) ───────────────────────────────────

const UNCOMMON: ReadonlyArray<CreatureEntry> = [
  { kind: 'acorn_woodpecker', displayName: 'Acorn Woodpecker', tier: 'uncommon', season: 'autumn' },
  { kind: 'bee',              displayName: 'Honeybee',         tier: 'uncommon' },
  { kind: 'dragonfly',        displayName: 'Dragonfly',        tier: 'uncommon' },
  { kind: 'firefly',          displayName: 'Firefly',          tier: 'uncommon', season: 'summer' },
  { kind: 'frog',             displayName: 'Garden Frog',      tier: 'uncommon' },
  { kind: 'garden_spider',    displayName: 'Garden Spider',    tier: 'uncommon' },
  { kind: 'hedgehog',         displayName: 'Hedgehog',         tier: 'uncommon' },
  { kind: 'hummingbird',      displayName: 'Hummingbird',      tier: 'uncommon' },
  { kind: 'mason_bee',        displayName: 'Mason Bee',        tier: 'uncommon', season: 'spring' },
  { kind: 'snow_bunting',     displayName: 'Snow Bunting',     tier: 'uncommon', season: 'winter' },
];

// ── Rare (4, no seasonal) ─────────────────────────────────────────────────

const RARE: ReadonlyArray<CreatureEntry> = [
  { kind: 'barn_owl',    displayName: 'Barn Owl',    tier: 'rare' },
  { kind: 'fox_kit',     displayName: 'Fox Kit',     tier: 'rare' },
  { kind: 'mockingbird', displayName: 'Mockingbird', tier: 'rare' },
  { kind: 'weasel',      displayName: 'Weasel',      tier: 'rare' },
];

// ── Legendary (4, no seasonal) ────────────────────────────────────────────

const LEGENDARY: ReadonlyArray<CreatureEntry> = [
  { kind: 'hare',    displayName: 'March Hare',  tier: 'legendary' },
  { kind: 'heron',   displayName: 'Great Heron', tier: 'legendary' },
  { kind: 'lynx',    displayName: 'Lynx',        tier: 'legendary' },
  { kind: 'peacock', displayName: 'Peacock',     tier: 'legendary' },
];

// ── Mythical (4, no seasonal, each with static gold flourish) ────────────
// "No animation in v1" — flourish strings describe the static treatment
// only. See spec → "Mythical tier (4, no seasonal — final roster)".

const MYTHICAL: ReadonlyArray<CreatureEntry> = [
  {
    kind: 'garden_imp',
    displayName: 'Garden Imp',
    tier: 'mythical',
    flourish: 'Gold-ink frame + gold-tipped horns + single gold pupil',
  },
  {
    kind: 'spirit_fox',
    displayName: 'Spirit Fox',
    tier: 'mythical',
    flourish: 'Gold frame + nine gold tail-strokes radiating',
  },
  {
    kind: 'wisp',
    displayName: 'Wisp',
    tier: 'mythical',
    flourish: 'Gold frame + gold radial gradient halo (static)',
  },
  {
    kind: 'dryad',
    displayName: 'Dryad',
    tier: 'mythical',
    flourish: 'Gold frame + gold leaf-veins on body',
  },
];

// ── Pools (the public shape consumed by rng.ts) ───────────────────────────

export const POOLS: Readonly<Record<PetRarity, ReadonlyArray<CreatureEntry>>> = {
  common: COMMON,
  uncommon: UNCOMMON,
  rare: RARE,
  legendary: LEGENDARY,
  mythical: MYTHICAL,
};

// Flat catalog (handy for tests / future tooling). Tier order matches POOLS.
export const BESTIARY: ReadonlyArray<CreatureEntry> = [
  ...COMMON,
  ...UNCOMMON,
  ...RARE,
  ...LEGENDARY,
  ...MYTHICAL,
];
