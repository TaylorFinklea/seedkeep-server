import { describe, it, expect } from 'vitest';
import { run as spawnPet } from '../spawn';
import { computePetSeed, rollRarity, rollCreatureKind, seasonFromEpochMs } from '../rng';
import { BESTIARY } from '../bestiary';
import { SHARED_FALLBACK_NAMES, fallbackNameForSeed } from '../fallback';

// Helper — build a Sprout-shaped JSON response string.
function makeSproutResponse(name: string, vignette: string, voiceHint: string): string {
  return JSON.stringify({ name, vignette, voice_hint: voiceHint });
}

describe('spawn.run — success path (Sprout mock)', () => {
  it('returns Sprout-named personality when the mock resolves cleanly', async () => {
    const calls: Array<{ system: string; userText: string }> = [];
    const result = await spawnPet({
      plantingEventId: 'pe-mock-success-1',
      apiKey: 'sk-test-1234',
      spawnedAt: Date.UTC(2026, 4, 15), // 2026-05-15 — spring (UTC)
      bedName: 'South Bed',
      seedVariety: { commonName: 'Tomato', scientificName: 'Solanum lycopersicum', customType: 'Cherokee Purple' },
      anthropicCaller: async ({ system, userText }) => {
        calls.push({ system, userText });
        return makeSproutResponse(
          'Pippin',
          'A small, watchful presence among the rows of tomatoes.',
          'speaks in observations, fond of long pauses',
        );
      },
    });

    expect(result.usedFallback).toBe(false);
    expect(result.petName).toBe('Pippin');
    expect(result.petSeed).toBe(computePetSeed('pe-mock-success-1'));
    expect(result.petRarity).toMatch(/^(common|uncommon|rare|legendary|mythical)$/);
    expect(result.petCreatureKind.length).toBeGreaterThan(0);
    // Display name should match the bestiary entry for the rolled kind.
    const entry = BESTIARY.find((e) => e.kind === result.petCreatureKind);
    expect(entry).toBeTruthy();
    expect(result.petCreatureDisplayName).toBe(entry!.displayName);

    // Persisted JSON is parseable + carries the right metadata.
    const persisted = JSON.parse(result.petPersonalityJson);
    expect(persisted.name).toBe('Pippin');
    expect(persisted.vignette).toMatch(/watchful/);
    expect(persisted.voice_hint).toMatch(/observations/);
    expect(persisted.version).toBe(1);
    expect(persisted.fallback).toBe(false);
    expect(persisted.fallback_attempts).toBe(0);

    // Prompt context included the seed variety + bed name.
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toMatch(/Sprout/i);
    expect(calls[0].userText).toContain('Tomato');
    expect(calls[0].userText).toContain('South Bed');
    expect(calls[0].userText).toContain('Solanum lycopersicum');
  });

  it('passes the correct rarity tier + creature kind to the prompt', async () => {
    let captured: string | null = null;
    const eventId = 'pe-prompt-rarity-1';
    const expectedSeed = computePetSeed(eventId);
    const expectedRarity = rollRarity(expectedSeed);
    const expectedSeason = seasonFromEpochMs(Date.UTC(2026, 6, 1));
    const expectedKind = rollCreatureKind(expectedSeed, expectedRarity, expectedSeason);

    await spawnPet({
      plantingEventId: eventId,
      apiKey: 'sk-test',
      spawnedAt: Date.UTC(2026, 6, 1),
      bedName: null,
      seedVariety: null,
      anthropicCaller: async ({ userText }) => {
        captured = userText;
        return makeSproutResponse('Sage', 'A quiet ally.', 'softly spoken');
      },
    });

    expect(captured).not.toBeNull();
    const parsed = JSON.parse(captured!);
    expect(parsed.rarity_tier).toBe(expectedRarity);
    expect(parsed.creature_kind).toBe(expectedKind);
    expect(parsed.season).toBe(expectedSeason);
    expect(parsed.bed_name).toBeNull();
    expect(parsed.seed_variety).toBeNull();
  });

  it('handles a fenced JSON response from the model', async () => {
    const result = await spawnPet({
      plantingEventId: 'pe-fenced-1',
      apiKey: 'sk-test',
      spawnedAt: Date.UTC(2026, 3, 1),
      bedName: null,
      seedVariety: null,
      anthropicCaller: async () => {
        return '```json\n' + makeSproutResponse('Wren', 'A small voice.', 'curt') + '\n```';
      },
    });
    expect(result.usedFallback).toBe(false);
    expect(result.petName).toBe('Wren');
  });
});

describe('spawn.run — failure path (fallback)', () => {
  it('falls back deterministically when apiKey is null', async () => {
    const result = await spawnPet({
      plantingEventId: 'pe-no-key-1',
      apiKey: null,
      spawnedAt: Date.UTC(2026, 5, 1),
      bedName: 'Side Bed',
      seedVariety: { commonName: 'Basil' },
    });

    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('no_api_key');
    // Name comes from the shared fallback pool, indexed by the pet_seed hash.
    const expectedName = fallbackNameForSeed(result.petSeed);
    expect(result.petName).toBe(expectedName);
    expect(SHARED_FALLBACK_NAMES).toContain(result.petName);

    const persisted = JSON.parse(result.petPersonalityJson);
    expect(persisted.name).toBe(expectedName);
    expect(persisted.fallback).toBe(true);
    expect(persisted.fallback_attempts).toBe(1);
    expect(persisted.last_attempt_at).toBe(Date.UTC(2026, 5, 1));
    expect(persisted.voice_hint).toBe('quiet, observant');
    expect(persisted.vignette).toMatch(new RegExp(`^${expectedName} the .+ has just arrived`));
  });

  it('falls back when the Anthropic caller throws', async () => {
    const result = await spawnPet({
      plantingEventId: 'pe-throw-1',
      apiKey: 'sk-test',
      spawnedAt: Date.UTC(2026, 7, 15),
      bedName: null,
      seedVariety: null,
      anthropicCaller: async () => {
        throw new Error('Anthropic one-shot returned 529: overloaded');
      },
    });
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toMatch(/529/);
    const persisted = JSON.parse(result.petPersonalityJson);
    expect(persisted.fallback).toBe(true);
  });

  it('falls back when the caller returns non-JSON', async () => {
    const result = await spawnPet({
      plantingEventId: 'pe-nonjson-1',
      apiKey: 'sk-test',
      spawnedAt: Date.UTC(2026, 8, 1),
      bedName: null,
      seedVariety: null,
      anthropicCaller: async () => 'I cannot comply with that request.',
    });
    expect(result.usedFallback).toBe(true);
    const persisted = JSON.parse(result.petPersonalityJson);
    expect(persisted.fallback).toBe(true);
  });

  it('falls back when the caller returns JSON missing required fields', async () => {
    const result = await spawnPet({
      plantingEventId: 'pe-badjson-1',
      apiKey: 'sk-test',
      spawnedAt: Date.UTC(2026, 9, 1),
      bedName: null,
      seedVariety: null,
      anthropicCaller: async () => JSON.stringify({ name: 'Nameless' }), // missing vignette + voice_hint
    });
    expect(result.usedFallback).toBe(true);
  });

  it('falls back when name exceeds 32 characters', async () => {
    const tooLong = 'A'.repeat(33);
    const result = await spawnPet({
      plantingEventId: 'pe-toolong-1',
      apiKey: 'sk-test',
      spawnedAt: Date.UTC(2026, 9, 1),
      bedName: null,
      seedVariety: null,
      anthropicCaller: async () =>
        makeSproutResponse(tooLong, 'A long-named creature.', 'verbose'),
    });
    expect(result.usedFallback).toBe(true);
  });

  it('fallback identity is deterministic across calls for the same event id', async () => {
    const a = await spawnPet({
      plantingEventId: 'pe-deterministic-1',
      apiKey: null,
      spawnedAt: 1717000000000,
      bedName: null,
      seedVariety: null,
    });
    const b = await spawnPet({
      plantingEventId: 'pe-deterministic-1',
      apiKey: null,
      spawnedAt: 1717000000000,
      bedName: null,
      seedVariety: null,
    });
    expect(a.petSeed).toBe(b.petSeed);
    expect(a.petName).toBe(b.petName);
    expect(a.petRarity).toBe(b.petRarity);
    expect(a.petCreatureKind).toBe(b.petCreatureKind);
  });

  it('fallback never blocks — returns a populated SpawnResult', async () => {
    const result = await spawnPet({
      plantingEventId: 'pe-resilience-1',
      apiKey: null,
      spawnedAt: Date.UTC(2026, 0, 15),
      bedName: null,
      seedVariety: null,
    });
    expect(result.petSeed.length).toBe(64);
    expect(result.petName.length).toBeGreaterThan(0);
    expect(result.petPersonalityJson.length).toBeGreaterThan(0);
  });
});

describe('spawn.run — invariants', () => {
  it('petCreatureKind always belongs to the rolled rarity tier', async () => {
    for (let i = 0; i < 50; i++) {
      const result = await spawnPet({
        plantingEventId: `pe-invariant-${i}`,
        apiKey: null, // skip Anthropic
        spawnedAt: Date.UTC(2026, i % 12, 1),
        bedName: null,
        seedVariety: null,
      });
      const entry = BESTIARY.find((e) => e.kind === result.petCreatureKind);
      expect(entry).toBeTruthy();
      expect(entry!.tier).toBe(result.petRarity);
    }
  });

  it('petPersonalityJson is valid JSON with version=1', async () => {
    const result = await spawnPet({
      plantingEventId: 'pe-version-1',
      apiKey: null,
      spawnedAt: Date.UTC(2026, 5, 5),
      bedName: null,
      seedVariety: null,
    });
    const parsed = JSON.parse(result.petPersonalityJson);
    expect(parsed.version).toBe(1);
    expect(typeof parsed.name).toBe('string');
    expect(typeof parsed.vignette).toBe('string');
    expect(typeof parsed.voice_hint).toBe('string');
    expect(Array.isArray(parsed.traits)).toBe(true);
    expect(typeof parsed.tone).toBe('string');
  });
});
