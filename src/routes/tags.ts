import { Hono } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { dbAll, dbGet, dbRun, isUniqueViolation } from '../db/helpers';
import { getSql } from '../db/client';
import { buildDeltaPayload, deltaCursorWhere, parseDeltaQuery } from '../lib/sync';

export const tagRoutes = new Hono<AppEnv>();

const auth = [requireAuth(), requireHousehold()] as const;

interface TagRow {
  id: string;
  household_id: string;
  name: string;
  color: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

const upsertSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().trim().max(20).nullish(),
});

// Create accepts an optional client-supplied id so the iOS sync engine
// can push offline creates idempotently (seeds pattern — retries with
// the same id replay the committed row instead of duplicating it).
const createSchema = upsertSchema.extend({
  id: z.string().min(1).max(80).optional(),
});

tagRoutes.get('/tags', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const sql = getSql(c.env);
  const query = parseDeltaQuery(new URL(c.req.url).searchParams);
  const cursor = deltaCursorWhere(query, 2);
  const params = [householdId, ...cursor.params, query.limit];
  const items = await dbAll<TagRow>(
    sql,
    `SELECT id, household_id, name, color, created_at, updated_at, deleted_at
       FROM tags
      WHERE household_id = $1 AND ${cursor.clause}
      ORDER BY updated_at ASC, id ASC
      LIMIT $${params.length}`,
    params,
  );
  return c.json({ ok: true, data: buildDeltaPayload(items, query) });
});

tagRoutes.post('/tags', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const sql = getSql(c.env);
  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: { code: 'bad_request', message: parsed.error.message } }, 400);
  }
  const id = parsed.data.id ?? nanoid();
  const now = Date.now();
  const color = parsed.data.color ?? null;
  try {
    await dbRun(
      sql,
      `INSERT INTO tags (id, household_id, name, color, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, householdId, parsed.data.name, color, now, now],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Retry of a create that already committed (response lost on the
      // wire). Replay the existing row as a success when it belongs to
      // this household — same response shape as a fresh create.
      const existing = await dbGet<TagRow>(
        sql,
        `SELECT id, household_id, name, color, created_at, updated_at, deleted_at
           FROM tags WHERE id = $1 AND household_id = $2 LIMIT 1`,
        [id, householdId],
      );
      if (existing) {
        return c.json({ ok: true, data: { tag: existing } });
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
      tag: {
        id,
        household_id: householdId,
        name: parsed.data.name,
        color,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      },
    },
  });
});

tagRoutes.patch('/tags/:id', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const id = c.req.param('id');
  const sql = getSql(c.env);
  const body = await c.req.json().catch(() => null);
  const parsed = upsertSchema.partial().safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: { code: 'bad_request', message: parsed.error.message } }, 400);
  }
  const existing = await dbGet<TagRow>(
    sql,
    `SELECT id, household_id, name, color, created_at, updated_at, deleted_at
       FROM tags WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [id, householdId],
  );
  if (!existing) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Tag not found' } }, 404);
  }
  const now = Date.now();
  const name = parsed.data.name ?? existing.name;
  const color = parsed.data.color !== undefined ? parsed.data.color : existing.color;
  await dbRun(
    sql,
    `UPDATE tags SET name = $1, color = $2, updated_at = $3 WHERE id = $4`,
    [name, color, now, id],
  );
  return c.json({
    ok: true,
    data: { tag: { ...existing, name, color, updated_at: now } },
  });
});

tagRoutes.delete('/tags/:id', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const id = c.req.param('id');
  const sql = getSql(c.env);
  const now = Date.now();
  const result = await dbRun(
    sql,
    `UPDATE tags SET deleted_at = $1, updated_at = $2
       WHERE id = $3 AND household_id = $4 AND deleted_at IS NULL`,
    [now, now, id, householdId],
  );
  if (result.meta.changes === 0) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Tag not found' } }, 404);
  }
  // Remove join rows so seeds no longer surface the deleted tag_id in their
  // tag_ids array.  Bump updated_at on affected seeds so delta-syncing clients
  // re-pull them and drop the stale tag_id from local state.
  await dbRun(
    sql,
    `UPDATE seeds SET updated_at = $1
       WHERE household_id = $2
         AND id IN (SELECT seed_id FROM seed_tags WHERE tag_id = $3 AND household_id = $2)`,
    [now, householdId, id],
  );
  await dbRun(
    sql,
    `DELETE FROM seed_tags WHERE tag_id = $1 AND household_id = $2`,
    [id, householdId],
  );
  return c.json({ ok: true, data: { id, deleted_at: now } });
});
