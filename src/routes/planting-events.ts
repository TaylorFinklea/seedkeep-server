import { Hono } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { dbAll, dbBatch, dbGet, dbRun, isFkViolation, isUniqueViolation, type Queryable } from '../db/helpers';
import { getSql } from '../db/client';
import { buildDeltaPayload, deltaCursorWhere, parseDeltaQuery } from '../lib/sync';
import { decryptApiKey } from '../lib/assistant/keyEncryption';
import { run as spawnPet } from '../lib/pets/spawn';
import { expectedVersion, invalidIfMatch, setVersionHeader, versionConflict } from '../lib/versioning';
import { deletePhoto } from '../lib/storage';

export const plantingEventRoutes = new Hono<AppEnv>();

const auth = [requireAuth(), requireHousehold()] as const;

// 'note' was accepted by zod but the DB CHECK (migration 0011) rejects it,
// causing a guaranteed 500. Dropped here so the server returns 400 instead.
const KINDS = ['sowing', 'transplant', 'harvest'] as const;
type PlantingEventKind = (typeof KINDS)[number];

interface PlantingEventRow {
  id: string;
  household_id: string;
  bed_id: string | null;
  seed_id: string | null;
  catalog_seed_id: string | null;
  kind: PlantingEventKind;
  // Postgres returns DATE as 'YYYY-MM-DD' string via postgres.js.
  planned_for: string;
  completed_at: number | null;
  notes: string | null;
  // Spatial layout — both null until the user places the event in
  // the bed. NUMERIC(5,2) round-trips through postgres.js as string;
  // we coerce to number for the JSON response.
  x_feet: number | null;
  y_feet: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  // Phase 5 — plant-pet identity (server-of-record). Nullable on legacy
  // rows; freshly-created rows are populated inline by the POST handler.
  pet_seed: string | null;
  pet_rarity: string | null;
  pet_creature_kind: string | null;
  pet_name: string | null;
  pet_personality: string | null;
  pet_spawned_at: number | null;
  version: number;
}

const upsertSchema = z.object({
  bed_id: z.string().trim().min(1).max(64).nullish(),
  seed_id: z.string().trim().min(1).max(64).nullish(),
  catalog_seed_id: z.string().trim().min(1).max(64).nullish(),
  kind: z.enum(KINDS),
  // ISO date — YYYY-MM-DD. We don't need time-of-day or timezone for a
  // garden plan; the client computes "X days from now" client-side.
  planned_for: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  completed_at: z.number().int().nullish(),
  notes: z.string().trim().max(2000).nullish(),
  x_feet: z.number().min(0).max(1000).nullish(),
  y_feet: z.number().min(0).max(1000).nullish(),
});

// Create accepts an optional client-supplied id so the iOS sync engine
// can push offline creates idempotently (seeds pattern — retries with
// the same id replay the committed row instead of duplicating it).
const createSchema = upsertSchema.extend({
  id: z.string().min(1).max(80).optional(),
});

const SELECT_COLS = `id, household_id, bed_id, seed_id, catalog_seed_id, kind,
  to_char(planned_for, 'YYYY-MM-DD') AS planned_for,
  completed_at, notes,
  x_feet::float8 AS x_feet, y_feet::float8 AS y_feet,
  created_at, updated_at, deleted_at,
  pet_seed, pet_rarity, pet_creature_kind, pet_name, pet_personality, pet_spawned_at, version`;

async function lockEventParents(q: Queryable, householdId: string, bedId: string | null, seedId: string | null): Promise<boolean> {
  if (bedId) {
    const bed = await dbGet<{ id: string }>(q,
      `SELECT id FROM beds WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR SHARE`, [bedId, householdId]);
    if (!bed) return false;
  }
  if (seedId) {
    const seed = await dbGet<{ id: string }>(q,
      `SELECT id FROM seeds WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR SHARE`, [seedId, householdId]);
    if (!seed) return false;
  }
  return true;
}

plantingEventRoutes.get('/planting-events', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const sql = getSql(c.env);
  const query = parseDeltaQuery(new URL(c.req.url).searchParams);
  const cursor = deltaCursorWhere(query, 2);
  const params = [householdId, ...cursor.params, query.limit];
  // Baseline pulls (since=0) hide soft-deletes; non-zero since includes
  // tombstones so clients can purge. Adds no param, so the LIMIT index holds.
  const softDeleteFilter = query.since === 0 ? ' AND deleted_at IS NULL' : '';
  const items = await dbAll<PlantingEventRow>(
    sql,
    `SELECT ${SELECT_COLS}
       FROM planting_events
      WHERE household_id = $1 AND ${cursor.clause}${softDeleteFilter}
      ORDER BY updated_at ASC, id ASC
      LIMIT $${params.length}`,
    params,
  );
  return c.json({ ok: true, data: buildDeltaPayload(items, query) });
});

plantingEventRoutes.post('/planting-events', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const sql = getSql(c.env);
  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: { code: 'bad_request', message: parsed.error.message } }, 400);
  }
  const id = parsed.data.id ?? nanoid();
  const now = Date.now();
  if (parsed.data.id) {
    const existing = await dbGet<PlantingEventRow>(sql,
      `SELECT ${SELECT_COLS} FROM planting_events WHERE id = $1 AND household_id = $2 LIMIT 1`, [id, householdId]);
    if (existing) {
      setVersionHeader(c, existing.version);
      return c.json({ ok: true, data: { planting_event: existing } });
    }
    if (await dbGet(sql, `SELECT id FROM planting_events WHERE id = $1`, [id])) return c.json({ ok: false, error: { code: 'conflict', message: 'A record with this id already exists.' } }, 409);
  }

  // Phase 5 — spawn a plant pet for this event. Identity columns are
  // populated inline so the POST response carries the fully-rolled pet.
  // Mirrors the synchronous Anthropic pattern in extractions.ts.
  const apiKey = await loadAnthropicKey(sql, c.env, householdId);
  const seedVariety = await loadSeedVariety(
    sql,
    householdId,
    parsed.data.seed_id ?? null,
    parsed.data.catalog_seed_id ?? null,
  );
  const bedName = await loadBedName(sql, householdId, parsed.data.bed_id ?? null);
  // Short timeout (~8s) for the optional pet vignette — the planting-event
  // create is a core sync write; a slow Anthropic response must not block
  // it indefinitely. The existing deterministic fallback covers timeouts.
  const SPAWN_TIMEOUT_MS = 8_000;
  const spawnController = new AbortController();
  const spawnTimer = setTimeout(() => spawnController.abort(), SPAWN_TIMEOUT_MS);
  const spawn = await spawnPet({
    plantingEventId: id,
    apiKey,
    spawnedAt: now,
    bedName,
    seedVariety,
    anthropicCaller: async (args) => {
      const { anthropicOneShot } = await import('../lib/pets/anthropicOneShot');
      try {
        return await anthropicOneShot({ ...args, signal: spawnController.signal });
      } finally {
        clearTimeout(spawnTimer);
      }
    },
  });

  // Phase 5.1.0 — alongside the event, seed a default journal entry +
  // "Watered" checklist item so the mood engine's thirst signal has
  // something to query on a fresh pet. Mirrors the journal.ts POST shape
  // exactly (INSERT into journal_entries with planned_for as occurred_on,
  // then INSERT a single unchecked checklist item). The seeded entry's
  // body is empty by convention — the checklist item is the payload.
  //
  // All three INSERTs run in ONE transaction so a retry of a create that
  // already committed can be replayed wholesale: the 23505 branch below
  // returns the existing row WITHOUT re-running the journal/checklist
  // seeding (which would duplicate them on every retry).
  const journalEntryId = nanoid();
  const checklistItemId = nanoid();
  try {
    await sql.begin(async (tx) => {
      if (!await lockEventParents(tx, householdId, parsed.data.bed_id ?? null, parsed.data.seed_id ?? null)) {
        throw Object.assign(new Error('invalid_reference'), { code: 'EVENT_INVALID_REFERENCE' });
      }
      const statements = [
      {
        sql: `INSERT INTO planting_events (
           id, household_id, bed_id, seed_id, catalog_seed_id,
           kind, planned_for, completed_at, notes,
           x_feet, y_feet,
           created_at, updated_at,
           pet_seed, pet_rarity, pet_creature_kind, pet_name,
           pet_personality, pet_spawned_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                   $14, $15, $16, $17, $18, $19)`,
        params: [
          id, householdId,
          parsed.data.bed_id ?? null,
          parsed.data.seed_id ?? null,
          parsed.data.catalog_seed_id ?? null,
          parsed.data.kind,
          parsed.data.planned_for,
          parsed.data.completed_at ?? null,
          parsed.data.notes ?? null,
          parsed.data.x_feet ?? null,
          parsed.data.y_feet ?? null,
          now, now,
          spawn.petSeed,
          spawn.petRarity,
          spawn.petCreatureKind,
          spawn.petName,
          spawn.petPersonalityJson,
          now, // pet_spawned_at = creation time
        ],
      },
      {
        sql: `INSERT INTO journal_entries
           (id, household_id, occurred_on, body, planting_event_id,
            created_at, updated_at)
         VALUES ($1, $2, $3, '', $4, $5, $5)`,
        params: [journalEntryId, householdId, parsed.data.planned_for, id, now],
      },
      {
        sql: `INSERT INTO journal_checklist_items
           (id, entry_id, text, completed, sort_order, updated_at)
         VALUES ($1, $2, 'Watered', FALSE, 0, $3)`,
        params: [checklistItemId, journalEntryId, now],
      },
      ];
      for (const stmt of statements) await dbRun(tx, stmt.sql, stmt.params);
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Retry of a create that already committed (response lost on the
      // wire). Replay the existing row as a success when it belongs to
      // this household — same response shape as a fresh create. The auto
      // journal entry + checklist item committed with the original
      // attempt; deliberately NOT re-created here.
      const existing = await dbGet<PlantingEventRow>(
        sql,
        `SELECT ${SELECT_COLS} FROM planting_events
          WHERE id = $1 AND household_id = $2 LIMIT 1`,
        [id, householdId],
      );
      if (existing) {
        setVersionHeader(c, existing.version);
        return c.json({ ok: true, data: { planting_event: existing } });
      }
      return c.json({
        ok: false,
        error: { code: 'conflict', message: 'A record with this id already exists.' },
      }, 409);
    }
    if (isFkViolation(err) || (err instanceof Error && err.message === 'invalid_reference')) {
      return c.json({
        ok: false,
        error: {
          code: 'invalid_reference',
          message:
            'A referenced bed, seed, or catalog row does not exist on the server. Sync the parent records first (Settings → Sync → Pending writes → Retry), then retry this planting event.',
        },
      }, 400);
    }
    throw err;
  }

  // SELECT … RETURNING pattern via fresh GET; we already wrote the row,
  // so a follow-up SELECT is the cleanest way to mirror the legacy shape
  // exactly (planned_for to_char, x_feet/y_feet cast, etc.).
  const row = await dbGet<PlantingEventRow>(
    sql,
    `SELECT ${SELECT_COLS} FROM planting_events WHERE id = $1 AND household_id = $2 LIMIT 1`,
    [id, householdId],
  );
  if (!row) {
    // Defensive — the row was just inserted; this would indicate a
    // serious DB inconsistency. Fall through with a synthesized payload.
    setVersionHeader(c, 1);
    return c.json({
      ok: true,
      data: {
        planting_event: {
          id, household_id: householdId,
          bed_id: parsed.data.bed_id ?? null,
          seed_id: parsed.data.seed_id ?? null,
          catalog_seed_id: parsed.data.catalog_seed_id ?? null,
          kind: parsed.data.kind,
          planned_for: parsed.data.planned_for,
          completed_at: parsed.data.completed_at ?? null,
          notes: parsed.data.notes ?? null,
          x_feet: parsed.data.x_feet ?? null,
          y_feet: parsed.data.y_feet ?? null,
          created_at: now, updated_at: now, deleted_at: null,
          pet_seed: spawn.petSeed,
          pet_rarity: spawn.petRarity,
          pet_creature_kind: spawn.petCreatureKind,
          pet_name: spawn.petName,
          pet_personality: spawn.petPersonalityJson,
          pet_spawned_at: now,
          version: 1,
        } satisfies PlantingEventRow,
      },
    });
  }
  setVersionHeader(c, row.version);
  return c.json({ ok: true, data: { planting_event: row } });
});

// ── Spawn helpers ─────────────────────────────────────────────────────────

/**
 * Load the household's encrypted Anthropic key + decrypt. Returns null
 * when:
 *   - The household has no BYOK key configured
 *   - `ASSISTANT_KEY_MASTER` is not configured on the server
 *   - The key fails to decrypt (master key rotated)
 *
 * Returning null routes the spawn through the deterministic fallback
 * path — the planting-event create succeeds either way. We deliberately
 * do NOT throw here; pet spawn must never block a planting create.
 */
async function loadAnthropicKey(
  sql: ReturnType<typeof getSql>,
  env: { ASSISTANT_KEY_MASTER?: string },
  householdId: string,
): Promise<string | null> {
  if (!env.ASSISTANT_KEY_MASTER) return null;
  interface KeyRow { encrypted_key: Buffer; key_iv: Buffer; key_tag: Buffer }
  const keyRow = await dbGet<KeyRow>(
    sql,
    `SELECT encrypted_key, key_iv, key_tag FROM assistant_keys
       WHERE household_id = $1 AND provider = 'anthropic' LIMIT 1`,
    [householdId],
  );
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

interface SeedVariety {
  commonName: string | null;
  scientificName?: string | null;
  customType?: string | null;
}

/**
 * Resolve a seed-variety descriptor for the Sprout prompt. Prefers the
 * household-local seed's custom_name + variety, falling back to the
 * catalog row's common/scientific name. Returns null when no seed is
 * referenced.
 */
async function loadSeedVariety(
  sql: ReturnType<typeof getSql>,
  householdId: string,
  seedId: string | null,
  catalogSeedId: string | null,
): Promise<SeedVariety | null> {
  if (seedId) {
    interface SeedRow {
      custom_name: string | null;
      custom_variety: string | null;
      catalog_common_name: string | null;
      catalog_scientific_name: string | null;
    }
    const row = await dbGet<SeedRow>(
      sql,
      `SELECT s.custom_name, s.custom_variety,
              cs.common_name AS catalog_common_name,
              cs.scientific_name AS catalog_scientific_name
         FROM seeds s
         LEFT JOIN catalog_seeds cs ON cs.id = s.catalog_id
        WHERE s.id = $1 AND s.household_id = $2 LIMIT 1`,
      [seedId, householdId],
    );
    if (row) {
      return {
        commonName: row.custom_name ?? row.catalog_common_name ?? null,
        scientificName: row.catalog_scientific_name ?? null,
        customType: row.custom_variety ?? null,
      };
    }
  }
  if (catalogSeedId) {
    interface CatalogRow {
      common_name: string | null;
      scientific_name: string | null;
    }
    const row = await dbGet<CatalogRow>(
      sql,
      `SELECT common_name, scientific_name
         FROM catalog_seeds WHERE id = $1 LIMIT 1`,
      [catalogSeedId],
    );
    if (row) {
      return {
        commonName: row.common_name,
        scientificName: row.scientific_name,
        customType: null,
      };
    }
  }
  return null;
}

async function loadBedName(
  sql: ReturnType<typeof getSql>,
  householdId: string,
  bedId: string | null,
): Promise<string | null> {
  if (!bedId) return null;
  const row = await dbGet<{ name: string }>(
    sql,
    `SELECT name FROM beds WHERE id = $1 AND household_id = $2 LIMIT 1`,
    [bedId, householdId],
  );
  return row?.name ?? null;
}

plantingEventRoutes.patch('/planting-events/:id', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const id = c.req.param('id');
  const sql = getSql(c.env);
  const body = await c.req.json().catch(() => null);
  const parsed = upsertSchema.partial().safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: { code: 'bad_request', message: parsed.error.message } }, 400);
  }
  const expected = expectedVersion(c);
  if (expected === 'invalid') return invalidIfMatch(c);
  const now = Date.now();
  const columns: Record<string, unknown> = {};
  for (const key of ['bed_id', 'seed_id', 'catalog_seed_id', 'kind', 'planned_for', 'completed_at', 'notes', 'x_feet', 'y_feet'] as const) {
    if (parsed.data[key] !== undefined) columns[key] = parsed.data[key] ?? null;
  }
  const names = Object.keys(columns);
  const sets = names.map((key, i) => `${key} = $${i + 1}`);
  sets.push(`updated_at = $${names.length + 1}`, 'version = version + 1');
  const params: unknown[] = [...names.map((key) => columns[key]), now, id, householdId];
  let where = `id = $${names.length + 2} AND household_id = $${names.length + 3} AND deleted_at IS NULL`;
  if (expected !== null) { params.push(expected); where += ` AND version = $${params.length}`; }
  let outcome: { row: PlantingEventRow | null; current: PlantingEventRow | null };
  try {
    outcome = await sql.begin(async (tx) => {
      const nextBed = parsed.data.bed_id !== undefined ? parsed.data.bed_id ?? null : null;
      const nextSeed = parsed.data.seed_id !== undefined ? parsed.data.seed_id ?? null : null;
      if (!await lockEventParents(tx, householdId, nextBed, nextSeed)) throw new Error('invalid_reference');
      const owner = await dbGet<PlantingEventRow>(tx,
        `SELECT ${SELECT_COLS} FROM planting_events WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, householdId]);
      if (!owner) return { row: null, current: null };
      const changed = await tx.unsafe<{ id: string }[]>(
        `UPDATE planting_events SET ${sets.join(', ')} WHERE ${where} RETURNING *`, params as never);
      if (!changed[0]) {
        return { row: null, current: await dbGet<PlantingEventRow>(tx,
          `SELECT ${SELECT_COLS} FROM planting_events WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`, [id, householdId]) };
      }
      return { row: await dbGet<PlantingEventRow>(tx,
        `SELECT ${SELECT_COLS} FROM planting_events WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`, [id, householdId]), current: null };
    });
  } catch (err) {
    if (isFkViolation(err) || (err instanceof Error && err.message === 'invalid_reference')) {
      return c.json({
        ok: false,
        error: {
          code: 'invalid_reference',
          message:
            'A referenced bed, seed, or catalog row does not exist on the server. Sync the parent records first, then retry this update.',
        },
      }, 400);
    }
    throw err;
  }
  if (!outcome!.row) {
    if (!outcome!.current) return c.json({ ok: false, error: { code: 'not_found', message: 'Event not found' } }, 404);
    if (expected !== null) return versionConflict(c, outcome!.current);
    return c.json({ ok: false, error: { code: 'not_found', message: 'Event not found' } }, 404);
  }
  setVersionHeader(c, outcome!.row.version);
  return c.json({ ok: true, data: { planting_event: outcome!.row } });
});

plantingEventRoutes.delete('/planting-events/:id', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const id = c.req.param('id');
  const sql = getSql(c.env);
  const expected = expectedVersion(c);
  if (expected === 'invalid') return invalidIfMatch(c);
  const now = Date.now();
  const outcome = await sql.begin(async (tx) => {
    const current = await dbGet<PlantingEventRow>(tx,
      `SELECT ${SELECT_COLS} FROM planting_events WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, householdId]);
    if (!current) return { row: null, current: null, keys: [] as string[] };
    const changed = await tx.unsafe<{ version: number }[]>(
      `UPDATE planting_events SET deleted_at = $1, updated_at = $1, version = version + 1
        WHERE id = $2 AND household_id = $3 AND deleted_at IS NULL${expected === null ? '' : ' AND version = $4'} RETURNING version`,
      expected === null ? [now, id, householdId] : [now, id, householdId, expected]);
    if (!changed[0]) return { row: null, current, keys: [] as string[] };
    const entryRows = await tx.unsafe<{ id: string }[]>(
      `SELECT id FROM journal_entries WHERE planting_event_id = $1 AND household_id = $2 AND deleted_at IS NULL ORDER BY id FOR UPDATE`, [id, householdId]);
    const entryIds = entryRows.map((e) => e.id);
    await tx.unsafe<{ id: string }[]>(
      `UPDATE journal_entries SET deleted_at = $1, updated_at = $1, version = version + 1
        WHERE id = ANY($2) AND household_id = $3 AND deleted_at IS NULL`, [now, entryIds, householdId]);
    const photos = await tx.unsafe<{ storage_key: string }[]>(
      `SELECT storage_key FROM journal_entry_photos WHERE entry_id = ANY($1) AND household_id = $2`, [entryIds, householdId]);
    await tx.unsafe(`DELETE FROM journal_entry_photos WHERE entry_id = ANY($1) AND household_id = $2`, [entryIds, householdId]);
    await tx.unsafe(`DELETE FROM journal_checklist_items WHERE entry_id = ANY($1)`, [entryIds]);
    return { row: { version: changed[0].version }, current: null, keys: photos.map((p) => p.storage_key) };
  });
  if (!outcome.row && !outcome.current) return c.json({ ok: false, error: { code: 'not_found', message: 'Event not found' } }, 404);
  if (outcome.current) {
    if (expected !== null) return versionConflict(c, outcome.current);
    return c.json({ ok: false, error: { code: 'not_found', message: 'Event not found' } }, 404);
  }
  await Promise.allSettled(outcome.keys.map((key) => deletePhoto(c.env, key)));
  setVersionHeader(c, outcome.row!.version);
  return c.json({ ok: true, data: { id, deleted_at: now, version: outcome.row!.version } });
});
