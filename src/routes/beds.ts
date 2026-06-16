import { Hono } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { dbAll, dbGet, dbRun, isUniqueViolation } from '../db/helpers';
import { getSql } from '../db/client';
import { buildDeltaPayload, deltaCursorWhere, parseDeltaQuery } from '../lib/sync';

export const bedRoutes = new Hono<AppEnv>();

const auth = [requireAuth(), requireHousehold()] as const;

interface BedRow {
  id: string;
  household_id: string;
  name: string;
  description: string | null;
  width_feet: string | null;     // numeric → string from postgres.js
  length_feet: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface BedDTO {
  id: string;
  household_id: string;
  name: string;
  description: string | null;
  width_feet: number | null;
  length_feet: number | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

function rowToDTO(row: BedRow): BedDTO {
  return {
    ...row,
    width_feet: row.width_feet === null ? null : Number(row.width_feet),
    length_feet: row.length_feet === null ? null : Number(row.length_feet),
  };
}

const upsertSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000).nullish(),
  width_feet: z.number().min(0).max(1000).nullish(),
  length_feet: z.number().min(0).max(1000).nullish(),
  sort_order: z.number().int().min(0).max(10000).optional(),
});

// Create accepts an optional client-supplied id so the iOS sync engine
// can push offline creates idempotently (seeds pattern — retries with
// the same id replay the committed row instead of duplicating it).
const createSchema = upsertSchema.extend({
  id: z.string().min(1).max(80).optional(),
});

const SELECT_COLS = `id, household_id, name, description,
  width_feet::text AS width_feet, length_feet::text AS length_feet,
  sort_order, created_at, updated_at, deleted_at`;

/**
 * GET /api/beds?since=<ms>&limit=<n>
 *
 * Delta-sync friendly listing. When `since=0`, soft-deletes are hidden;
 * any non-zero `since` includes deletes so clients can purge. Mirrors the
 * seeds + journal feeds.
 */
bedRoutes.get('/beds', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const sql = getSql(c.env);
  const query = parseDeltaQuery(new URL(c.req.url).searchParams);
  const cursor = deltaCursorWhere(query, 2);
  const params = [householdId, ...cursor.params, query.limit];
  // Baseline pulls (since=0) hide soft-deletes; non-zero since includes
  // tombstones so clients can purge. Adds no param, so the LIMIT index holds.
  const softDeleteFilter = query.since === 0 ? ' AND deleted_at IS NULL' : '';
  const items = await dbAll<BedRow>(
    sql,
    `SELECT ${SELECT_COLS}
       FROM beds
      WHERE household_id = $1 AND ${cursor.clause}${softDeleteFilter}
      ORDER BY updated_at ASC, id ASC
      LIMIT $${params.length}`,
    params,
  );
  return c.json({ ok: true, data: buildDeltaPayload(items.map(rowToDTO), query) });
});

bedRoutes.post('/beds', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const sql = getSql(c.env);
  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: { code: 'bad_request', message: parsed.error.message } }, 400);
  }
  const id = parsed.data.id ?? nanoid();
  const now = Date.now();
  const sortOrder = parsed.data.sort_order ?? 0;
  try {
    await dbRun(
      sql,
      `INSERT INTO beds (id, household_id, name, description, width_feet, length_feet, sort_order, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id, householdId,
        parsed.data.name,
        parsed.data.description ?? null,
        parsed.data.width_feet ?? null,
        parsed.data.length_feet ?? null,
        sortOrder, now, now,
      ],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Retry of a create that already committed (response lost on the
      // wire). Replay the existing row as a success when it belongs to
      // this household — same response shape as a fresh create.
      const existing = await dbGet<BedRow>(
        sql,
        `SELECT ${SELECT_COLS}
           FROM beds WHERE id = $1 AND household_id = $2 LIMIT 1`,
        [id, householdId],
      );
      if (existing) {
        return c.json({ ok: true, data: { bed: rowToDTO(existing) } });
      }
      return c.json({
        ok: false,
        error: { code: 'conflict', message: 'A record with this id already exists.' },
      }, 409);
    }
    throw err;
  }
  return c.json({
    ok: true,
    data: {
      bed: {
        id, household_id: householdId,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        width_feet: parsed.data.width_feet ?? null,
        length_feet: parsed.data.length_feet ?? null,
        sort_order: sortOrder,
        created_at: now, updated_at: now, deleted_at: null,
      } satisfies BedDTO,
    },
  });
});

bedRoutes.patch('/beds/:id', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const id = c.req.param('id');
  const sql = getSql(c.env);
  const body = await c.req.json().catch(() => null);
  const parsed = upsertSchema.partial().safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: { code: 'bad_request', message: parsed.error.message } }, 400);
  }
  const existing = await dbGet<BedRow>(
    sql,
    `SELECT ${SELECT_COLS}
       FROM beds WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [id, householdId],
  );
  if (!existing) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Bed not found' } }, 404);
  }
  const now = Date.now();
  const name = parsed.data.name ?? existing.name;
  const description = parsed.data.description === undefined
    ? existing.description
    : parsed.data.description ?? null;
  const width = parsed.data.width_feet === undefined
    ? (existing.width_feet === null ? null : Number(existing.width_feet))
    : parsed.data.width_feet ?? null;
  const length = parsed.data.length_feet === undefined
    ? (existing.length_feet === null ? null : Number(existing.length_feet))
    : parsed.data.length_feet ?? null;
  const sortOrder = parsed.data.sort_order ?? existing.sort_order;
  await dbRun(
    sql,
    `UPDATE beds SET name = $1, description = $2, width_feet = $3, length_feet = $4,
       sort_order = $5, updated_at = $6 WHERE id = $7`,
    [name, description, width, length, sortOrder, now, id],
  );
  return c.json({
    ok: true,
    data: {
      bed: {
        id, household_id: householdId,
        name, description,
        width_feet: width, length_feet: length,
        sort_order: sortOrder,
        created_at: existing.created_at, updated_at: now, deleted_at: null,
      } satisfies BedDTO,
    },
  });
});

bedRoutes.delete('/beds/:id', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const id = c.req.param('id');
  const sql = getSql(c.env);
  const now = Date.now();
  const result = await dbRun(
    sql,
    `UPDATE beds SET deleted_at = $1, updated_at = $2
       WHERE id = $3 AND household_id = $4 AND deleted_at IS NULL`,
    [now, now, id, householdId],
  );
  if (result.meta.changes === 0) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Bed not found' } }, 404);
  }
  // Cascade soft-delete to children — planting_events + journal_entries
  // scoped to this bed. iOS sees matching tombstones on the next pull.
  await dbRun(sql,
    `UPDATE planting_events SET deleted_at = $1, updated_at = $1
       WHERE bed_id = $2 AND household_id = $3 AND deleted_at IS NULL`,
    [now, id, householdId]);
  await dbRun(sql,
    `UPDATE journal_entries SET deleted_at = $1, updated_at = $1
       WHERE bed_id = $2 AND household_id = $3 AND deleted_at IS NULL`,
    [now, id, householdId]);
  return c.json({ ok: true, data: { id, deleted_at: now } });
});
