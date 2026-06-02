// Sprout prompt builders + response parsers for plant-pet identity.
//
// Two call sites (spec → "Sprout integration"):
//   1. Personality vignette at spawn — `buildPersonalityPrompt` +
//      `parsePersonalityResponse`. Called by `spawn.ts`.
//   2. Goodbye note at departure — `buildDepartureNotePrompt` +
//      `parseDepartureNoteResponse`. Used by Phase 5.1.1's depart route.
//
// Both use the same one-shot Anthropic client (`anthropicOneShot.ts`).
// Schema-validation failure / non-JSON / Anthropic error are all signalled
// by throwing — the caller wraps in try/catch and routes to fallback.
//
// `version: 1` is stamped by the caller (`spawn.ts`) when writing to the
// DB; the parsers here only validate the Sprout-facing surface (name,
// vignette, voice_hint, traits, tone for personality; note_text, signoff
// for departure).

import { z } from 'zod';
import type { PetRarity, PetSeason } from './bestiary';

// ── Personality (spawn) ───────────────────────────────────────────────────

export interface PersonalityPromptArgs {
  rarityTier: PetRarity;
  creatureKind: string;
  creatureDisplayName: string;
  /** Bed display name, or null when the planting has no bed. */
  bedName: string | null;
  season: PetSeason;
  seedVariety: {
    commonName: string | null;
    scientificName?: string | null;
    customType?: string | null;
  } | null;
  /** Optional weather snapshot — currently always null from the server caller. */
  weatherSnapshot?: { tempF: number; condition: string } | null;
}

const PERSONALITY_SYSTEM_PROMPT = `You are Sprout, a small folkloric narrator who introduces companion creatures for a household's garden in the voice of an antique Herbarium field journal.

Write a brief introduction for the creature in second-person voice, addressing the gardener. Tone: warm, slightly archaic, observational; never twee. Avoid emojis, modern slang, or marketing tone.

You will be given JSON context. Return STRICT JSON ONLY — no preamble, no code fences, no commentary — matching exactly this shape:

{
  "name": string,        // 1-32 characters, the creature's chosen name. Folkloric, not generic.
  "vignette": string,    // 1-4 short sentences (length keyed to rarity_flourish_hint).
  "voice_hint": string   // ONE sentence of voice notes for any future companion lines (e.g. "speaks in short observations, fond of the word 'thence'").
}

Hard rules:
- Output JSON object only. No markdown, no fences, no surrounding prose.
- The "name" is the creature's name, not a description.
- Do not mention the gardener by name (you don't know it).
- Match the rarity_flourish_hint sentence count exactly.`;

function rarityFlourishHint(tier: PetRarity): string {
  switch (tier) {
    case 'common':
    case 'uncommon':
      return '1-2 sentence vignette; plain warmth; no mythical claims.';
    case 'rare':
      return '2-3 sentence vignette; allow one specific, evocative detail.';
    case 'legendary':
      return '3 sentence vignette; include one memorable concrete detail that anchors the creature in this gardener\'s plot.';
    case 'mythical':
      return '3-4 sentence vignette; mythopoetic flourish; folkloric naming; one detail hinting at the creature\'s reputation.';
  }
}

/**
 * Build the system + user prompts for a personality vignette call.
 * Returns the two strings ready to pass to `anthropicOneShot`.
 */
export function buildPersonalityPrompt(args: PersonalityPromptArgs): {
  system: string;
  userText: string;
} {
  const context = {
    rarity_tier: args.rarityTier,
    creature_kind: args.creatureKind,
    creature_display_name: args.creatureDisplayName,
    bed_name: args.bedName,
    season: args.season,
    seed_variety: args.seedVariety
      ? {
          common_name: args.seedVariety.commonName,
          scientific_name: args.seedVariety.scientificName ?? null,
          custom_type: args.seedVariety.customType ?? null,
        }
      : null,
    weather_snapshot: args.weatherSnapshot
      ? { tempF: args.weatherSnapshot.tempF, condition: args.weatherSnapshot.condition }
      : null,
    rarity_flourish_hint: rarityFlourishHint(args.rarityTier),
  };

  return {
    system: PERSONALITY_SYSTEM_PROMPT,
    userText: JSON.stringify(context),
  };
}

// Zod schema — spec-locked shape from "Sprout integration → Output".
const PersonalitySchema = z.object({
  name: z.string().trim().min(1).max(32),
  vignette: z.string().trim().min(1).max(800),
  voice_hint: z.string().trim().min(1).max(300),
  // Sprout doesn't author traits/tone; we accept either nothing or
  // best-effort guidance the model volunteers. Stored as [] / "".
  traits: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
  tone: z.string().trim().max(80).optional(),
}).strict();

export interface ParsedPersonality {
  name: string;
  vignette: string;
  voiceHint: string;
  traits: string[];
  tone: string;
  version: number;
}

const PERSONALITY_VERSION = 1;

/**
 * Parse + validate Sprout's personality response. Throws if the text is
 * not strict JSON matching the locked schema.
 */
export function parsePersonalityResponse(text: string): ParsedPersonality {
  const parsed = stripFencedJson(text);
  const validated = PersonalitySchema.parse(parsed);
  return {
    name: validated.name,
    vignette: validated.vignette,
    voiceHint: validated.voice_hint,
    traits: validated.traits ?? [],
    tone: validated.tone ?? '',
    version: PERSONALITY_VERSION,
  };
}

// ── Departure note (Phase 5.1.1) ──────────────────────────────────────────

export interface DepartureNotePromptArgs {
  petName: string;
  voiceHint: string;
  creatureDisplayName: string;
  rarityTier: PetRarity;
  daysAlive: number;
  reason: 'inactivity' | 'wilted_too_long' | 'user_dismissed';
  /** Optional 1-2 sentence summary; falls back to a static phrase if absent. */
  moodHistorySummary?: string | null;
}

const DEPARTURE_SYSTEM_PROMPT = `You are writing a brief farewell from a garden companion creature to its caretaker. The tone is warm, dignified, slightly archaic — an old-book voice. Not sad, not chipper. Avoid emojis, marketing language, exclamation marks unless the voice_hint demands them.

You will be given JSON context describing the creature, how long it lived alongside the caretaker, and why it is leaving. Write the note in the creature's first-person voice. Return STRICT JSON ONLY — no preamble, no code fences — matching exactly this shape:

{
  "note_text": string,   // 1-4 short sentences in the creature's voice.
  "signoff": string      // 1-32 characters; typically "— <pet_name>" or a small flourish.
}

Hard rules:
- Output JSON object only. No markdown, no fences.
- Speak as the creature (first person), not as the narrator.
- Honor the voice_hint exactly.`;

function reasonPhrase(reason: DepartureNotePromptArgs['reason']): string {
  switch (reason) {
    case 'inactivity': return 'you stopped responding';
    case 'wilted_too_long': return 'you were away too long';
    case 'user_dismissed': return 'you said goodbye';
  }
}

/**
 * Build the system + user prompts for a goodbye note call.
 */
export function buildDepartureNotePrompt(args: DepartureNotePromptArgs): {
  system: string;
  userText: string;
} {
  const context = {
    pet_name: args.petName,
    voice_hint: args.voiceHint,
    creature_display_name: args.creatureDisplayName,
    rarity_tier: args.rarityTier,
    days_alive: Math.max(0, Math.floor(args.daysAlive)),
    reason: reasonPhrase(args.reason),
    mood_history_summary: args.moodHistorySummary ?? 'mood history unavailable',
  };
  return {
    system: DEPARTURE_SYSTEM_PROMPT,
    userText: JSON.stringify(context),
  };
}

const DepartureNoteSchema = z.object({
  note_text: z.string().trim().min(1).max(800),
  signoff: z.string().trim().min(1).max(32),
}).strict();

export interface ParsedDepartureNote {
  noteText: string;
  signoff: string;
}

/**
 * Parse + validate Sprout's goodbye note response. Throws on schema
 * failure or non-JSON input.
 */
export function parseDepartureNoteResponse(text: string): ParsedDepartureNote {
  const parsed = stripFencedJson(text);
  const validated = DepartureNoteSchema.parse(parsed);
  return {
    noteText: validated.note_text,
    signoff: validated.signoff,
  };
}

// ── Shared JSON-text helpers ──────────────────────────────────────────────

/**
 * Sprout is instructed to return strict JSON with no fences, but the
 * Anthropic models occasionally still wrap output. Strip a single set
 * of ```json … ``` fences if present, then parse. Throws on parse fail.
 */
function stripFencedJson(text: string): unknown {
  const trimmed = text.trim();
  // Match optional fenced wrapper.
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const inner = fence ? fence[1].trim() : trimmed;
  return JSON.parse(inner);
}
