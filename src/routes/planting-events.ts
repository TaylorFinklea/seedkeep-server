import { Hono } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { dbAll, dbGet, dbRun } from '../db/helpers';
import { getSql } from '../db/client';
import { buildDeltaPayload, parseDeltaQuery } from '../lib/sync';

export const plantingEventRoutes = new Hono<AppEnv>();

const auth = [requireAuth(), requireHousehold()] as const;

const KINDS = ['sowing', 'transplant', 'harvest', 'note'] as const;
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

const SELECT_COLS = `id, household_id, bed_id, seed_id, catalog_seed_id, kind,
  to_char(planned_for, 'YYYY-MM-DD') AS planned_for,
  completed_at, notes,
  x_feet::float8 AS x_feet, y_feet::float8 AS y_feet,
  created_at, updated_at, deleted_at`;

plantingEventRoutes.get('/planting-events', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const sql = getSql(c.env);
  const query = parseDeltaQuery(new URL(c.req.url).searchParams);
  const items = await dbAll<PlantingEventRow>(
    sql,
    `SELECT ${SELECT_COLS}
       FROM planting_events
      WHERE household_id = $1 AND updated_at > $2
      ORDER BY updated_at ASC
      LIMIT $3`,
    [householdId, query.since, query.limit],
  );
  return c.json({ ok: true, data: buildDeltaPayload(items, query) });
});

plantingEventRoutes.post('/planting-events', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const sql = getSql(c.env);
  const body = await c.req.json().catch(() => null);
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: { code: 'bad_request', message: parsed.error.message } }, 400);
  }
  const id = nanoid();
  const now = Date.now();
  try {
    await dbRun(
      sql,
      `INSERT INTO planting_events (
         id, household_id, bed_id, seed_id, catalog_seed_id,
         kind, planned_for, completed_at, notes,
         x_feet, y_feet,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
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
      ],
    );
  } catch (err) {
    // Postgres SQLSTATE 23503 = foreign_key_violation. The iOS client
    // routinely sends bed_id / seed_id values that refer to local-only
    // rows whose own create writes haven't synced yet (or failed). A
    // 500 with an HTML body here causes the iOS sync engine to mark
    // the write as decode_failed; a clean 400 lets it dead-letter
    // cleanly so the user can retry the parent writes first.
    if ((err as { code?: string }).code === '23503') {
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
      } satisfies PlantingEventRow,
    },
  });
});

plantingEventRoutes.patch('/planting-events/:id', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const id = c.req.param('id');
  const sql = getSql(c.env);
  const body = await c.req.json().catch(() => null);
  const parsed = upsertSchema.partial().safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: { code: 'bad_request', message: parsed.error.message } }, 400);
  }
  const existing = await dbGet<PlantingEventRow>(
    sql,
    `SELECT ${SELECT_COLS}
       FROM planting_events WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [id, householdId],
  );
  if (!existing) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Event not found' } }, 404);
  }
  const now = Date.now();
  const merged: PlantingEventRow = {
    ...existing,
    bed_id: parsed.data.bed_id === undefined ? existing.bed_id : parsed.data.bed_id ?? null,
    seed_id: parsed.data.seed_id === undefined ? existing.seed_id : parsed.data.seed_id ?? null,
    catalog_seed_id: parsed.data.catalog_seed_id === undefined ? existing.catalog_seed_id : parsed.data.catalog_seed_id ?? null,
    kind: parsed.data.kind ?? existing.kind,
    planned_for: parsed.data.planned_for ?? existing.planned_for,
    completed_at: parsed.data.completed_at === undefined ? existing.completed_at : parsed.data.completed_at ?? null,
    notes: parsed.data.notes === undefined ? existing.notes : parsed.data.notes ?? null,
    x_feet: parsed.data.x_feet === undefined ? existing.x_feet : parsed.data.x_feet ?? null,
    y_feet: parsed.data.y_feet === undefined ? existing.y_feet : parsed.data.y_feet ?? null,
    updated_at: now,
  };
  await dbRun(
    sql,
    `UPDATE planting_events SET
       bed_id = $1, seed_id = $2, catalog_seed_id = $3,
       kind = $4, planned_for = $5, completed_at = $6, notes = $7,
       x_feet = $8, y_feet = $9,
       updated_at = $10
     WHERE id = $11`,
    [
      merged.bed_id, merged.seed_id, merged.catalog_seed_id,
      merged.kind, merged.planned_for, merged.completed_at, merged.notes,
      merged.x_feet, merged.y_feet,
      now, id,
    ],
  );
  return c.json({ ok: true, data: { planting_event: merged } });
});

plantingEventRoutes.delete('/planting-events/:id', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const id = c.req.param('id');
  const sql = getSql(c.env);
  const now = Date.now();
  const result = await dbRun(
    sql,
    `UPDATE planting_events SET deleted_at = $1, updated_at = $2
       WHERE id = $3 AND household_id = $4 AND deleted_at IS NULL`,
    [now, now, id, householdId],
  );
  if (result.meta.changes === 0) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Event not found' } }, 404);
  }
  return c.json({ ok: true, data: { id, deleted_at: now } });
});
