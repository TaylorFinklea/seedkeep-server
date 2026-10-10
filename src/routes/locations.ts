import { Hono } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { dbAll, dbGet, dbRun, isUniqueViolation } from '../db/helpers';
import { getSql } from '../db/client';
import { buildDeltaPayload, deltaCursorWhere, parseDeltaQuery } from '../lib/sync';
import {
  expectedVersion,
  invalidIfMatch,
  setVersionHeader,
  versionConflict,
} from '../lib/versioning';

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
  version: number;
}

const LOCATION_COLS = `id, household_id, name, sort_order, created_at, updated_at, deleted_at, version`;

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
    `SELECT ${LOCATION_COLS}
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
      `INSERT INTO locations (id, household_id, name, sort_order, created_at, updated_at, version)
       VALUES ($1, $2, $3, $4, $5, $6, 1)`,
      [id, householdId, parsed.data.name, sortOrder, now, now],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Retry of a create that already committed (response lost on the
      // wire). Replay the existing row as a success when it belongs to
      // this household — same response shape as a fresh create.
      const existing = await dbGet<LocationRow>(
        sql,
        `SELECT ${LOCATION_COLS}
           FROM locations WHERE id = $1 AND household_id = $2 LIMIT 1`,
        [id, householdId],
      );
      if (existing) {
        setVersionHeader(c, existing.version);
        return c.json({ ok: true, data: { location: existing } });
      }
      return c.json({
        ok: false,
        error: { code: 'conflict', message: 'A record with this id already exists.' },
      }, 409);
    }
    throw err;
  }
  setVersionHeader(c, 1);
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
        version: 1,
      },
    },
  });
});

locationRoutes.patch('/locations/:id', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const id = c.req.param('id');
  const sql = getSql(c.env);
  const expected = expectedVersion(c);
  if (expected === 'invalid') return invalidIfMatch(c);
  const body = await c.req.json().catch(() => null);
  const parsed = upsertSchema.partial().safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: { code: 'bad_request', message: parsed.error.message } }, 400);
  }

  // Field-selective: only the provided columns are written. No read-merge-write.
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (parsed.data.name !== undefined) set('name', parsed.data.name);
  if (parsed.data.sort_order !== undefined) set('sort_order', parsed.data.sort_order);
  set('updated_at', Date.now());
  sets.push('version = version + 1');
  params.push(id, householdId);
  const where = `id = $${params.length - 1} AND household_id = $${params.length}`;

  // Lock, compare and update in one transaction. The 404-vs-409 decision
  // is made on the locked row, so no separate read follows the UPDATE.
  const outcome = await sql.begin(async (tx) => {
    const current = await dbGet<LocationRow>(
      tx,
      `SELECT ${LOCATION_COLS} FROM locations WHERE id = $1 AND household_id = $2 FOR UPDATE`,
      [id, householdId],
    );
    if (!current || current.deleted_at !== null) return { kind: 'not_found' as const };
    if (expected !== null && Number(current.version) !== expected) {
      return { kind: 'conflict' as const, current };
    }
    const updated = await dbGet<LocationRow>(
      tx,
      `UPDATE locations SET ${sets.join(', ')} WHERE ${where} RETURNING ${LOCATION_COLS}`,
      params,
    );
    return { kind: 'ok' as const, updated: updated! };
  });
  if (outcome.kind === 'not_found') {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Location not found' } }, 404);
  }
  if (outcome.kind === 'conflict') {
    return versionConflict(c, outcome.current);
  }
  setVersionHeader(c, outcome.updated.version);
  return c.json({ ok: true, data: { location: outcome.updated } });
});

locationRoutes.delete('/locations/:id', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const id = c.req.param('id');
  const sql = getSql(c.env);
  const expected = expectedVersion(c);
  if (expected === 'invalid') return invalidIfMatch(c);
  const now = Date.now();

  const outcome = await sql.begin(async (tx) => {
    // Lock the parent first so a concurrent seed write that references this
    // location (which takes FOR SHARE) serializes with the delete.
    const row = await dbGet<LocationRow>(
      tx,
      `SELECT ${LOCATION_COLS} FROM locations
        WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [id, householdId],
    );
    if (!row) return { kind: 'not_found' as const };
    if (expected !== null && Number(row.version) !== expected) {
      return { kind: 'conflict' as const, current: row };
    }
    // Lock the affected seeds in a deterministic order (id), then update them.
    const seedIds = (await dbAll<{ id: string }>(
      tx,
      `SELECT id FROM seeds
        WHERE household_id = $1 AND location_id = $2 AND deleted_at IS NULL
        ORDER BY id FOR UPDATE`,
      [householdId, id],
    )).map((r) => r.id);
    if (seedIds.length > 0) {
      await dbRun(
        tx,
        `UPDATE seeds SET location_id = NULL, updated_at = $1, version = version + 1
          WHERE household_id = $2 AND id = ANY($3)`,
        [now, householdId, seedIds],
      );
    }
    const tombstoned = await dbGet<{ version: number }>(
      tx,
      `UPDATE locations SET deleted_at = $1, updated_at = $1, version = version + 1
        WHERE id = $2 AND household_id = $3 RETURNING version`,
      [now, id, householdId],
    );
    return { kind: 'ok' as const, version: Number(tombstoned!.version) };
  });

  if (outcome.kind === 'not_found') {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Location not found' } }, 404);
  }
  if (outcome.kind === 'conflict') {
    return versionConflict(c, outcome.current);
  }
  setVersionHeader(c, outcome.version);
  return c.json({ ok: true, data: { id, deleted_at: now, version: outcome.version } });
});
