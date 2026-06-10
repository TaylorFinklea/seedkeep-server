// Phase 5.1.1 — plant-pet lifecycle routes.
//
// Today this exposes only `POST /api/pets/:planting_event_id/depart`.
// The spec (→ "Lifecycle → Server-side depart route" and
// "Sync → Departure: POST returns inline + next-pull confirms") calls for
// a one-shot RPC that:
//   1. Row-locks the planting via `SELECT ... FOR UPDATE` to serialise
//      concurrent departure attempts from two devices.
//   2. Refuses graduated plantings (409).
//   3. Returns the existing `pet_departures` row idempotently when a
//      departure has already been recorded — no second Sprout call,
//      response body byte-identical to the first.
//   4. Otherwise generates the goodbye note via the same one-shot
//      Anthropic client used for personality vignettes, falling back to
//      a deterministic `{ note_text: "I'll miss you.", signoff: "— <name>" }`
//      payload on any failure path.
//
// This is the first route in the codebase to use `SELECT ... FOR UPDATE`
// (per spec, deliberately documented as a new convention). Helper
// consolidation is deferred until a second use case appears.

import { Hono } from 'hono';
import { z } from 'zod';
import type { TransactionSql } from 'postgres';
import type { AppEnv } from '../index';
import { getSql } from '../db/client';
import { dbAll } from '../db/helpers';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { decryptApiKey } from '../lib/assistant/keyEncryption';
import { buildDepartureNotePrompt, parseDepartureNoteResponse } from '../lib/pets/sprout';
import { anthropicOneShot } from '../lib/pets/anthropicOneShot';
import { BESTIARY, type PetRarity } from '../lib/pets/bestiary';
import { parseDeltaQuery, buildDeltaPayload, deltaCursorWhere } from '../lib/sync';

export const petRoutes = new Hono<AppEnv>();

const auth = [requireAuth(), requireHousehold()] as const;

// ── Test seam ─────────────────────────────────────────────────────────────
// The depart route makes a network call to Anthropic. Tests need to swap
// it out without spinning up a mock HTTP server. Mirrors the
// `anthropicCaller` injection point on `spawn.ts:SpawnArgs` — same shape,
// module-scoped so the route handler can read it without thread-throughs.
export interface DepartureAnthropicCaller {
  (args: {
    apiKey: string;
    model: string;
    system: string;
    userText: string;
  }): Promise<string>;
}

let testCaller: DepartureAnthropicCaller | null = null;

/** Test-only: swap the Anthropic caller for one that returns a canned
 *  string (or throws). Pass null to restore the default. */
export function __setDepartureCallerForTests(
  fn: DepartureAnthropicCaller | null,
): void {
  testCaller = fn;
}

const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEPARTURE_MAX_TOKENS = 250;

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
    maxTokens: DEPARTURE_MAX_TOKENS,
  });
}

// ── Schemas + types ───────────────────────────────────────────────────────

const DEPART_REASONS = ['inactivity', 'wilted_too_long', 'user_dismissed'] as const;
type DepartReason = (typeof DEPART_REASONS)[number];

// Body is optional; absent body means reason='wilted_too_long' (the
// dominant trigger — iOS hits this after the 5-day streak threshold).
const departBodySchema = z.object({
  reason: z.enum(DEPART_REASONS).optional(),
}).strict();

interface PlantingEventLockRow {
  id: string;
  household_id: string;
  bed_id: string | null;
  seed_id: string | null;
  catalog_seed_id: string | null;
  kind: string;
  planned_for: string;
  completed_at: number | null;
  notes: string | null;
  x_feet: number | null;
  y_feet: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  pet_seed: string | null;
  pet_rarity: string | null;
  pet_creature_kind: string | null;
  pet_name: string | null;
  pet_personality: string | null;
  pet_spawned_at: number | null;
}

interface PetDepartureRow {
  planting_event_id: string;
  household_id: string;
  goodbye_note: string | null;
  reason: string;
  departed_at: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface PetPersonalityJson {
  name?: string;
  voice_hint?: string;
}

interface GoodbyePayload {
  note_text: string;
  signoff: string;
  fallback: boolean;
  fallback_attempts: number;
  last_attempt_at: number;
}

// ── GET /api/pets/departures ──────────────────────────────────────────────
//
// Delta-sync feed for Menagerie. Mirrors `journal.ts:GET /` exactly:
// `parseDeltaQuery` reads `since`+`limit`, `buildDeltaPayload` produces the
// `{ items, cursor, has_more }` envelope, and we hide tombstones when
// `since=0` so first-pull clients don't materialize already-deleted rows.
// Any non-zero `since` includes tombstones so the iOS sync engine can
// cascade `LocalPetDeparture` deletes.
//
// Rows are returned in their raw snake_case shape (mirrors the POST
// /depart response's `departure` field) so the iOS `PetDepartureDTO`
// decoder reuses the same property names.
petRoutes.get('/pets/departures', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId');
  const query = parseDeltaQuery(new URL(c.req.url).searchParams);

  // This feed's primary key is planting_event_id, so it doubles as the
  // cursor tiebreaker id.
  const cursor = deltaCursorWhere(query, 2, { id: 'planting_event_id' });
  const wheres: string[] = ['household_id = $1', cursor.clause];
  const params: unknown[] = [householdId, ...cursor.params];
  if (query.since === 0) wheres.push('deleted_at IS NULL');
  params.push(query.limit);

  const rows = await dbAll<PetDepartureRow>(
    sql,
    `SELECT planting_event_id, household_id, goodbye_note, reason,
            departed_at, created_at, updated_at, deleted_at
       FROM pet_departures
      WHERE ${wheres.join(' AND ')}
      ORDER BY updated_at ASC, planting_event_id ASC
      LIMIT $${params.length}`,
    params,
  );

  return c.json({ ok: true, data: buildDeltaPayload(rows, query, (r) => r.planting_event_id) });
});

// ── POST /api/pets/:planting_event_id/depart ──────────────────────────────

petRoutes.post('/pets/:planting_event_id/depart', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const plantingEventId = c.req.param('planting_event_id');
  const sql = getSql(c.env);

  // Body is optional — empty body resolves to default reason.
  let reason: DepartReason = 'wilted_too_long';
  const rawBody = await c.req.json().catch(() => null);
  if (rawBody !== null) {
    const parsed = departBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { ok: false, error: { code: 'bad_request', message: parsed.error.message } },
        400,
      );
    }
    if (parsed.data.reason) reason = parsed.data.reason;
  }

  // Transaction holds the row-level lock across the depart-or-idempotent
  // branch. Without `sql.begin`, the SELECT ... FOR UPDATE releases its
  // lock immediately, and two concurrent depart requests could each see
  // "no existing departure" and both run Sprout.
  //
  // Anthropic call is INSIDE the transaction on purpose: the lock must
  // be held until the INSERT completes so the second caller blocks until
  // the row exists and then takes the idempotent branch on retry.
  type DepartOutcome =
    | { kind: 'not_found' }
    | { kind: 'already_graduated' }
    | { kind: 'ok'; row: PlantingEventLockRow; departure: PetDepartureRow };

  const outcome: DepartOutcome = await sql.begin(async (tx) => {
    // 1) Lock the planting. `FOR UPDATE` is the new convention this route
    //    introduces (spec → race-conditions section).
    const lockRows = await tx.unsafe<PlantingEventLockRow[]>(
      `SELECT id, household_id, bed_id, seed_id, catalog_seed_id, kind,
              to_char(planned_for, 'YYYY-MM-DD') AS planned_for,
              completed_at, notes,
              x_feet::float8 AS x_feet, y_feet::float8 AS y_feet,
              created_at, updated_at, deleted_at,
              pet_seed, pet_rarity, pet_creature_kind, pet_name,
              pet_personality, pet_spawned_at
         FROM planting_events
        WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL
        FOR UPDATE`,
      [plantingEventId, householdId],
    );
    const row = lockRows[0] as PlantingEventLockRow | undefined;
    if (!row) return { kind: 'not_found' } as const;

    // 2) Graduated pets cannot depart (terminal state precedence).
    if (row.completed_at !== null) return { kind: 'already_graduated' } as const;

    // 3) Existing departure → idempotent return. Spec invariant: second
    //    call returns same row, no Sprout invocation.
    const existingRows = await tx.unsafe<PetDepartureRow[]>(
      `SELECT planting_event_id, household_id, goodbye_note, reason,
              departed_at, created_at, updated_at, deleted_at
         FROM pet_departures
        WHERE planting_event_id = $1 AND deleted_at IS NULL
        LIMIT 1`,
      [plantingEventId],
    );
    const existing = existingRows[0] as PetDepartureRow | undefined;
    if (existing) {
      return { kind: 'ok', row, departure: existing } as const;
    }

    // 4) Generate the goodbye note. The Sprout call sits inside the
    //    transaction to keep the row lock held until INSERT lands; a
    //    competing depart POST blocks on the SELECT FOR UPDATE above.
    const personality = parsePersonalityJson(row.pet_personality);
    const petName = personality?.name ?? row.pet_name ?? 'your companion';
    const voiceHint = personality?.voice_hint ?? 'quiet, observant';
    const displayName = bestiaryDisplayName(row.pet_creature_kind, row.pet_rarity);
    const rarityTier = normalizeRarity(row.pet_rarity);
    const daysAlive = computeDaysAlive(row.pet_spawned_at, Date.now());

    const { system, userText } = buildDepartureNotePrompt({
      petName,
      voiceHint,
      creatureDisplayName: displayName,
      rarityTier,
      daysAlive,
      reason,
    });

    const apiKey = await loadAnthropicKeyTx(tx, c.env, householdId);
    const caller = testCaller ?? defaultCaller;

    let goodbyePayload: GoodbyePayload;
    if (!apiKey) {
      goodbyePayload = buildFallbackGoodbye(petName, Date.now());
    } else {
      try {
        const text = await caller({
          apiKey,
          model: DEFAULT_MODEL,
          system,
          userText,
        });
        const parsed = parseDepartureNoteResponse(text);
        goodbyePayload = {
          note_text: parsed.noteText,
          signoff: parsed.signoff,
          fallback: false,
          fallback_attempts: 0,
          last_attempt_at: Date.now(),
        };
      } catch {
        goodbyePayload = buildFallbackGoodbye(petName, Date.now());
      }
    }

    // 5) INSERT the departure. created_at = updated_at = departed_at on
    //    initial insert — mirrors the journal_entries convention.
    const now = Date.now();
    const goodbyeJson = JSON.stringify(goodbyePayload);
    const insertedRows = await tx.unsafe<PetDepartureRow[]>(
      `INSERT INTO pet_departures
         (planting_event_id, household_id, goodbye_note, reason,
          departed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5, $5)
       RETURNING planting_event_id, household_id, goodbye_note, reason,
                 departed_at, created_at, updated_at, deleted_at`,
      [plantingEventId, householdId, goodbyeJson, reason, now],
    );
    const inserted = insertedRows[0] as PetDepartureRow | undefined;
    if (!inserted) {
      // Defensive — RETURNING should always yield exactly one row.
      throw new Error('pet_departures INSERT returned no row');
    }

    // Bump the planting's updated_at so sibling devices learn about the
    // depart via the existing /planting-events delta-sync feed. The
    // dedicated /pets/departures feed (Phase 5.1.4) will also carry it.
    await tx.unsafe(
      `UPDATE planting_events SET updated_at = $1 WHERE id = $2`,
      [now, plantingEventId],
    );
    row.updated_at = now;

    return { kind: 'ok', row, departure: inserted } as const;
  });

  if (outcome.kind === 'not_found') {
    return c.json(
      { ok: false, error: { code: 'not_found', message: 'planting event not found' } },
      404,
    );
  }
  if (outcome.kind === 'already_graduated') {
    return c.json(
      {
        ok: false,
        error: { code: 'already_graduated', message: 'graduated pets cannot depart' },
      },
      409,
    );
  }

  return c.json({
    ok: true,
    data: {
      planting_event: outcome.row,
      departure: outcome.departure,
    },
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────

function buildFallbackGoodbye(petName: string, now: number): GoodbyePayload {
  return {
    note_text: "I'll miss you.",
    signoff: `— ${petName}`,
    fallback: true,
    fallback_attempts: 1,
    last_attempt_at: now,
  };
}

function parsePersonalityJson(raw: string | null): PetPersonalityJson | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PetPersonalityJson;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

function bestiaryDisplayName(
  creatureKind: string | null,
  rarity: string | null,
): string {
  if (!creatureKind) return 'companion';
  const tier = normalizeRarity(rarity);
  const entry =
    BESTIARY.find((e) => e.kind === creatureKind && e.tier === tier)
    ?? BESTIARY.find((e) => e.kind === creatureKind);
  return entry?.displayName ?? creatureKind;
}

function normalizeRarity(rarity: string | null): PetRarity {
  switch (rarity) {
    case 'uncommon':
    case 'rare':
    case 'legendary':
    case 'mythical':
      return rarity;
    case 'common':
    default:
      return 'common';
  }
}

function computeDaysAlive(spawnedAt: number | null, now: number): number {
  if (!spawnedAt) return 0;
  const ms = Math.max(0, now - spawnedAt);
  return Math.floor(ms / 86_400_000);
}

/**
 * Load the household's decrypted Anthropic key inside an open transaction.
 * Mirrors `planting-events.ts:loadAnthropicKey` exactly — same SELECT,
 * same null-on-any-failure shape — but reads through the active
 * transaction handle so the row lock stays consistent.
 *
 * Returns null when the household has no key configured, the master key
 * is missing, or decryption fails. The caller routes through the
 * deterministic fallback goodbye in any of those cases.
 *
 * `tx` is the postgres.js `TransactionSql` handle from `sql.begin`.
 */
async function loadAnthropicKeyTx(
  tx: TransactionSql,
  env: { ASSISTANT_KEY_MASTER?: string },
  householdId: string,
): Promise<string | null> {
  if (!env.ASSISTANT_KEY_MASTER) return null;
  interface KeyRow { encrypted_key: Buffer; key_iv: Buffer; key_tag: Buffer }
  const rows = await tx.unsafe<KeyRow[]>(
    `SELECT encrypted_key, key_iv, key_tag FROM assistant_keys
       WHERE household_id = $1 AND provider = 'anthropic' LIMIT 1`,
    [householdId],
  );
  const keyRow = rows[0] as KeyRow | undefined;
  if (!keyRow) return null;
  try {
    return decryptApiKey(
      { ciphertext: keyRow.encrypted_key, iv: keyRow.key_iv, tag: keyRow.key_tag },
      env.ASSISTANT_KEY_MASTER,
    );
  } catch {
    return null;
  }
}
