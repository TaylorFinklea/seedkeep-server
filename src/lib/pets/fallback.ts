// Deterministic fallback identity for a plant pet when Sprout fails.
//
// Spec (→ "Sprout integration → Failure behavior"):
//   - Pull a name from a SHARED_FALLBACK_NAMES pool (~40 entries) keyed
//     by sha256(pet_seed) % 40. Shared across all creature kinds — the
//     per-kind 20-names-each option (~880 names) was rejected as
//     authoring overhead.
//   - Vignette: `"${name} the ${displayName.toLowerCase()} has just
//     arrived in your garden."`
//   - voice_hint: `"quiet, observant"`.
//   - Stamp `fallback: true, fallback_attempts: 1, last_attempt_at: now`
//     so a future retry job can promote the row to a real vignette.
//
// Pure module — no I/O, no Date.now() reads (caller passes `now`). Easy
// to unit-test.

import { createHash } from 'node:crypto';

// 40-name folkloric pool. Order is fixed — adding entries at the END is
// safe and reshuffles only the high end of the keyspace. NEVER remove an
// entry: existing fallback rows derive their name from this index.
export const SHARED_FALLBACK_NAMES: ReadonlyArray<string> = [
  'Acanthus',
  'Beatrix',
  'Borage',
  'Chamomile',
  'Cicely',
  'Clover',
  'Comfrey',
  'Cress',
  'Damson',
  'Dill',
  'Elder',
  'Fennel',
  'Gilly',
  'Hawthorne',
  'Hester',
  'Hyssop',
  'Jess',
  'Juniper',
  'Larkin',
  'Lavender',
  'Linden',
  'Marigold',
  'Mercer',
  'Mireille',
  'Mullein',
  'Nettle',
  'Oren',
  'Parsley',
  'Pippin',
  'Quill',
  'Rowan',
  'Sage',
  'Sorrel',
  'Sweetbriar',
  'Tansy',
  'Thistle',
  'Vetch',
  'Wren',
  'Yarrow',
  'Zinnia',
];

if (SHARED_FALLBACK_NAMES.length !== 40) {
  // Defensive: any future edit must keep the pool size constant or the
  // hash-modulo lookup shifts every previously-stamped fallback name.
  throw new Error(
    `SHARED_FALLBACK_NAMES must contain exactly 40 entries (got ${SHARED_FALLBACK_NAMES.length})`,
  );
}

/**
 * Deterministic name index for a given pet_seed. Computes sha256 of the
 * seed, takes the first 4 hex chars (16 bits, plenty for mod 40), and
 * indexes into SHARED_FALLBACK_NAMES.
 *
 * Same pet_seed → same name forever, even across retry attempts.
 */
export function fallbackNameForSeed(petSeedHex: string): string {
  const hash = createHash('sha256').update(petSeedHex, 'utf8').digest('hex');
  // First 4 hex chars → 0..65535. mod 40 is uniform enough for a 40-bucket pool.
  const index = parseInt(hash.slice(0, 4), 16) % SHARED_FALLBACK_NAMES.length;
  return SHARED_FALLBACK_NAMES[index];
}

export interface FallbackPersonalityArgs {
  petSeedHex: string;
  creatureDisplayName: string;
  /** Epoch ms — caller passes Date.now() (or a fixed value in tests). */
  now: number;
  /** For retry runs; defaults to 1 (first failure). */
  fallbackAttempts?: number;
}

export interface FallbackPersonality {
  name: string;
  vignette: string;
  voiceHint: string;
  traits: string[];
  tone: string;
  version: number;
  fallback: true;
  fallbackAttempts: number;
  lastAttemptAt: number;
}

const FALLBACK_VERSION = 1;

/**
 * Build the deterministic fallback identity. Returns the same shape the
 * caller writes to `planting_events.pet_personality` (JSON-encoded).
 */
export function buildFallbackPersonality(args: FallbackPersonalityArgs): FallbackPersonality {
  const name = fallbackNameForSeed(args.petSeedHex);
  const displayLower = args.creatureDisplayName.toLowerCase();
  return {
    name,
    vignette: `${name} the ${displayLower} has just arrived in your garden.`,
    voiceHint: 'quiet, observant',
    traits: [],
    tone: '',
    version: FALLBACK_VERSION,
    fallback: true,
    fallbackAttempts: args.fallbackAttempts ?? 1,
    lastAttemptAt: args.now,
  };
}
