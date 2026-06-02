// Plant-pet spawn orchestrator. Combines the deterministic RNG roll with
// the Sprout personality call, falling back to deterministic identity
// when Sprout fails or no API key is configured.
//
// Called inline from the POST /api/planting-events route handler after
// the planting_event INSERT. Returns the values the caller writes to
// the planting_events row via UPDATE … SET pet_personality = $1,
// pet_name = $2 … RETURNING *.
//
// Spec (→ "Sprout integration → Personality vignette generation"):
//   - Server is authoritative; client never re-rolls.
//   - Failure routes (no key / Anthropic error / schema fail / non-JSON)
//     all land on the deterministic fallback path with `fallback: true,
//     fallback_attempts: 1, last_attempt_at: now`. The user sees the
//     fallback; no error surfaced to the iOS client.
//   - One Anthropic call per planting lifetime. The retry job (Phase
//     5.1.6+) replaces fallback rows with real vignettes on success.

import {
  computePetSeed,
  rollRarity,
  rollCreatureKind,
  seasonFromEpochMs,
} from './rng';
import { BESTIARY, type CreatureEntry, type PetRarity, type PetSeason } from './bestiary';
import {
  buildPersonalityPrompt,
  parsePersonalityResponse,
  type ParsedPersonality,
} from './sprout';
import { buildFallbackPersonality } from './fallback';
import { anthropicOneShot } from './anthropicOneShot';

// ── Public surface ────────────────────────────────────────────────────────

export interface SpawnArgs {
  plantingEventId: string;
  /** Decrypted Anthropic API key, or null when the household has no key. */
  apiKey: string | null;
  /** Epoch ms the planting was created (= pet_spawned_at). */
  spawnedAt: number;
  bedName: string | null;
  seedVariety: {
    commonName: string | null;
    scientificName?: string | null;
    customType?: string | null;
  } | null;
  /** Override model name (defaults to `DEFAULT_MODEL`). */
  model?: string;
  /** Test seam — swap in a fake Anthropic caller. Returns the raw text. */
  anthropicCaller?: (args: {
    apiKey: string;
    model: string;
    system: string;
    userText: string;
  }) => Promise<string>;
}

/** Persistable identity produced by a spawn. Matches the columns the
 *  POST handler writes onto `planting_events`. `petPersonalityJson` is
 *  the full TEXT JSON payload (already stringified). */
export interface SpawnResult {
  petSeed: string;
  petRarity: PetRarity;
  petCreatureKind: string;
  petCreatureDisplayName: string;
  petName: string;
  petPersonalityJson: string;
  /** True if Sprout call was skipped or failed and the fallback was used. */
  usedFallback: boolean;
  /** Error message, when fallback was triggered by a failure path. */
  fallbackReason?: string;
}

const DEFAULT_MODEL = 'claude-haiku-4-5';

/**
 * Roll deterministic identity, call Sprout (if a key is present), and
 * return the identity fields ready to UPDATE onto the row.
 *
 * Never throws — every failure routes through the fallback path so the
 * planting-event creation request can complete with a populated pet.
 */
export async function run(args: SpawnArgs): Promise<SpawnResult> {
  const petSeed = computePetSeed(args.plantingEventId);
  const petRarity = rollRarity(petSeed);
  const season: PetSeason = seasonFromEpochMs(args.spawnedAt);
  const petCreatureKind = rollCreatureKind(petSeed, petRarity, season);
  const entry = findEntry(petCreatureKind, petRarity);
  const displayName = entry?.displayName ?? petCreatureKind;

  // No API key configured for this household → permanent fallback path.
  // Spec: "If no key configured, spawn falls back deterministically."
  if (!args.apiKey) {
    return buildFallbackResult({
      petSeed,
      petRarity,
      petCreatureKind,
      displayName,
      now: args.spawnedAt,
      reason: 'no_api_key',
    });
  }

  const { system, userText } = buildPersonalityPrompt({
    rarityTier: petRarity,
    creatureKind: petCreatureKind,
    creatureDisplayName: displayName,
    bedName: args.bedName,
    season,
    seedVariety: args.seedVariety,
  });

  const caller = args.anthropicCaller ?? defaultCaller;
  let parsed: ParsedPersonality;
  try {
    const text = await caller({
      apiKey: args.apiKey,
      model: args.model ?? DEFAULT_MODEL,
      system,
      userText,
    });
    parsed = parsePersonalityResponse(text);
  } catch (err) {
    return buildFallbackResult({
      petSeed,
      petRarity,
      petCreatureKind,
      displayName,
      now: args.spawnedAt,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  // Success path — wrap Sprout's response in the persisted JSON shape.
  const personalityJson = JSON.stringify({
    name: parsed.name,
    vignette: parsed.vignette,
    voice_hint: parsed.voiceHint,
    traits: parsed.traits,
    tone: parsed.tone,
    version: parsed.version,
    fallback: false,
    fallback_attempts: 0,
    last_attempt_at: args.spawnedAt,
  });
  return {
    petSeed,
    petRarity,
    petCreatureKind,
    petCreatureDisplayName: displayName,
    petName: parsed.name,
    petPersonalityJson: personalityJson,
    usedFallback: false,
  };
}

// ── Internals ─────────────────────────────────────────────────────────────

function findEntry(kind: string, rarity: PetRarity): CreatureEntry | undefined {
  return BESTIARY.find((e) => e.kind === kind && e.tier === rarity)
    ?? BESTIARY.find((e) => e.kind === kind);
}

interface BuildFallbackArgs {
  petSeed: string;
  petRarity: PetRarity;
  petCreatureKind: string;
  displayName: string;
  now: number;
  reason: string;
}

function buildFallbackResult(args: BuildFallbackArgs): SpawnResult {
  const fallback = buildFallbackPersonality({
    petSeedHex: args.petSeed,
    creatureDisplayName: args.displayName,
    now: args.now,
  });
  const personalityJson = JSON.stringify({
    name: fallback.name,
    vignette: fallback.vignette,
    voice_hint: fallback.voiceHint,
    traits: fallback.traits,
    tone: fallback.tone,
    version: fallback.version,
    fallback: true,
    fallback_attempts: fallback.fallbackAttempts,
    last_attempt_at: fallback.lastAttemptAt,
  });
  return {
    petSeed: args.petSeed,
    petRarity: args.petRarity,
    petCreatureKind: args.petCreatureKind,
    petCreatureDisplayName: args.displayName,
    petName: fallback.name,
    petPersonalityJson: personalityJson,
    usedFallback: true,
    fallbackReason: args.reason,
  };
}

async function defaultCaller(args: {
  apiKey: string;
  model: string;
  system: string;
  userText: string;
}): Promise<string> {
  return anthropicOneShot({
    apiKey: args.apiKey,
    model: args.model,
    system: args.system,
    userText: args.userText,
    maxTokens: 400,
  });
}
