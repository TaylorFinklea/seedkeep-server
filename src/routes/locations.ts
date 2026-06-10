import { Hono } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { dbAll, dbGet, dbRun, isUniqueViolation } from '../db/helpers';
import { getSql } from '../db/client';
import { buildDeltaPayload, deltaCursorWhere, parseDeltaQuery } from '../lib/sync';

export const locationRoutes = new Hono<AppEnv>();

// Per-route middleware composition (instead of `use('*')` which bleeds
// across sibling routers in Hono when mounted at a shared prefix).
const auth = [requireAuth(), requireHousehold()] as const;

interface LocationRow {
  id: string;
  household_id: string;
  name: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

const upsertSchema = z.object({
  name: z.string().trim().min(1).max(80),
  sort_order: z.number().int().min(0).max(10000).optional(),
});

// Create accepts an optional client-supplied id so the iOS sync engine
// can push offline creates idempotently (seeds pattern — retries with
// the same id replay the committed row instead of duplicating it).
const createSchema = upsertSchema.extend({
  id: z.string().min(1).max(80).optional(),
});

/**
 * GET /api/locations?since=<ms>&limit=<n>
 *
 * Delta-sync friendly listing. Returns locations updated after `since`,
 * including soft-deletes so clients can purge.
 */
locationRoutes.get('/locations', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const sql = getSql(c.env);
  const query = parseDeltaQuery(new URL(c.req.url).searchParams);
  const cursor = deltaCursorWhere(query, 2);
  const params = [householdId, ...cursor.params, query.limit];
  const items = await dbAll<LocationRow>(
    sql,
    `SELECT id, household_id, name, sort_order, created_at, updated_at, deleted_at
       FROM locations
      WHERE household_id = $1 AND ${cursor.clause}
      ORDER BY updated_at ASC, id ASC
      LIMIT $${params.length}`,
    params,
  );
  return c.json({ ok: true, data: buildDeltaPayload(items, query) });
});

locationRoutes.post('/locations', ...auth, async (c) => {
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
      `INSERT INTO locations (id, household_id, name, sort_order, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, householdId, parsed.data.name, sortOrder, now, now],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Retry of a create that already committed (response lost on the
      // wire). Replay the existing row as a success when it belongs to
      // this household — same response shape as a fresh create.
      const existing = await dbGet<LocationRow>(
        sql,
        `SELECT id, household_id, name, sort_order, created_at, updated_at, deleted_at
           FROM locations WHERE id = $1 AND household_id = $2 LIMIT 1`,
        [id, householdId],
      );
      if (existing) {
        return c.json({ ok: true, data: { location: existing } });
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
      location: {
        id,
        household_id: householdId,
        name: parsed.data.name,
        sort_order: sortOrder,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      },
    },
  });
});

locationRoutes.patch('/locations/:id', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const id = c.req.param('id');
  const sql = getSql(c.env);
  const body = await c.req.json().catch(() => null);
  const parsed = upsertSchema.partial().safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: { code: 'bad_request', message: parsed.error.message } }, 400);
  }
  const existing = await dbGet<LocationRow>(
    sql,
    `SELECT id, household_id, name, sort_order, created_at, updated_at, deleted_at
       FROM locations WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [id, householdId],
  );
  if (!existing) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Location not found' } }, 404);
  }
  const now = Date.now();
  const name = parsed.data.name ?? existing.name;
  const sortOrder = parsed.data.sort_order ?? existing.sort_order;
  await dbRun(
    sql,
    `UPDATE locations SET name = $1, sort_order = $2, updated_at = $3 WHERE id = $4`,
    [name, sortOrder, now, id],
  );
  return c.json({
    ok: true,
    data: {
      location: { ...existing, name, sort_order: sortOrder, updated_at: now },
    },
  });
});

locationRoutes.delete('/locations/:id', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const id = c.req.param('id');
  const sql = getSql(c.env);
  const now = Date.now();
  const result = await dbRun(
    sql,
    `UPDATE locations SET deleted_at = $1, updated_at = $2
       WHERE id = $3 AND household_id = $4 AND deleted_at IS NULL`,
    [now, now, id, householdId],
  );
  if (result.meta.changes === 0) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Location not found' } }, 404);
  }
  return c.json({ ok: true, data: { id, deleted_at: now } });
});
