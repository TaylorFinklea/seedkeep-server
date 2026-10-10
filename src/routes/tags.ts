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
  version: number;
}

const TAG_COLS = `id, household_id, name, color, created_at, updated_at, deleted_at, version`;

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
    `SELECT ${TAG_COLS}
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
      `INSERT INTO tags (id, household_id, name, color, created_at, updated_at, version)
       VALUES ($1, $2, $3, $4, $5, $6, 1)`,
      [id, householdId, parsed.data.name, color, now, now],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Retry of a create that already committed (response lost on the
      // wire). Replay the existing row as a success when it belongs to
      // this household — same response shape as a fresh create.
      const existing = await dbGet<TagRow>(
        sql,
        `SELECT ${TAG_COLS} FROM tags WHERE id = $1 AND household_id = $2 LIMIT 1`,
        [id, householdId],
      );
      if (existing) {
        setVersionHeader(c, existing.version);
        return c.json({ ok: true, data: { tag: existing } });
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
      tag: {
        id,
        household_id: householdId,
        name: parsed.data.name,
        color,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        version: 1,
      },
    },
  });
});

tagRoutes.patch('/tags/:id', ...auth, async (c) => {
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
  if (parsed.data.color !== undefined) set('color', parsed.data.color ?? null);
  set('updated_at', Date.now());
  sets.push('version = version + 1');
  params.push(id, householdId);
  const where = `id = $${params.length - 1} AND household_id = $${params.length}`;

  // Lock, compare and update in one transaction. The 404-vs-409 decision
  // is made on the locked row, so no separate read follows the UPDATE.
  const outcome = await sql.begin(async (tx) => {
    const current = await dbGet<TagRow>(
      tx,
      `SELECT ${TAG_COLS} FROM tags WHERE id = $1 AND household_id = $2 FOR UPDATE`,
      [id, householdId],
    );
    if (!current || current.deleted_at !== null) return { kind: 'not_found' as const };
    if (expected !== null && Number(current.version) !== expected) {
      return { kind: 'conflict' as const, current };
    }
    const updated = await dbGet<TagRow>(
      tx,
      `UPDATE tags SET ${sets.join(', ')} WHERE ${where} RETURNING ${TAG_COLS}`,
      params,
    );
    return { kind: 'ok' as const, updated: updated! };
  });
  if (outcome.kind === 'not_found') {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Tag not found' } }, 404);
  }
  if (outcome.kind === 'conflict') {
    return versionConflict(c, outcome.current);
  }
  setVersionHeader(c, outcome.updated.version);
  return c.json({ ok: true, data: { tag: outcome.updated } });
});

tagRoutes.delete('/tags/:id', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const id = c.req.param('id');
  const sql = getSql(c.env);
  const expected = expectedVersion(c);
  if (expected === 'invalid') return invalidIfMatch(c);
  const now = Date.now();

  const outcome = await sql.begin(async (tx) => {
    const row = await dbGet<TagRow>(
      tx,
      `SELECT ${TAG_COLS} FROM tags
        WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [id, householdId],
    );
    if (!row) return { kind: 'not_found' as const };
    if (expected !== null && Number(row.version) !== expected) {
      return { kind: 'conflict' as const, current: row };
    }
    // Lock the affected seeds in a deterministic order (id), then bump them
    // so delta-syncing clients re-pull and drop the stale tag_id. Must run
    // before the join rows are removed.
    const seedIds = (await dbAll<{ id: string }>(
      tx,
      `SELECT id FROM seeds
        WHERE household_id = $1
          AND id IN (SELECT seed_id FROM seed_tags WHERE tag_id = $2 AND household_id = $1)
        ORDER BY id FOR UPDATE`,
      [householdId, id],
    )).map((r) => r.id);
    if (seedIds.length > 0) {
      await dbRun(
        tx,
        `UPDATE seeds SET updated_at = $1, version = version + 1
          WHERE household_id = $2 AND id = ANY($3)`,
        [now, householdId, seedIds],
      );
    }
    await dbRun(
      tx,
      `DELETE FROM seed_tags WHERE tag_id = $1 AND household_id = $2`,
      [id, householdId],
    );
    const tombstoned = await dbGet<{ version: number }>(
      tx,
      `UPDATE tags SET deleted_at = $1, updated_at = $1, version = version + 1
        WHERE id = $2 AND household_id = $3 RETURNING version`,
      [now, id, householdId],
    );
    return { kind: 'ok' as const, version: Number(tombstoned!.version) };
  });

  if (outcome.kind === 'not_found') {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Tag not found' } }, 404);
  }
  if (outcome.kind === 'conflict') {
    return versionConflict(c, outcome.current);
  }
  setVersionHeader(c, outcome.version);
  return c.json({ ok: true, data: { id, deleted_at: now, version: outcome.version } });
});
