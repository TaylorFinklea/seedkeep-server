import { Hono } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { dbAll, dbGet, dbRun, isUniqueViolation } from '../db/helpers';
import { getSql } from '../db/client';
import { buildDeltaPayload, deltaCursorWhere, parseDeltaQuery } from '../lib/sync';
import { deletePhoto } from '../lib/storage';
import {
  expectedVersion,
  invalidIfMatch,
  setVersionHeader,
  versionConflict,
} from '../lib/versioning';

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
  version: number;
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
  version: number;
}

function rowToDTO(row: BedRow): BedDTO {
  return {
    ...row,
    version: Number(row.version),
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
  sort_order, created_at, updated_at, deleted_at, version`;

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
      `INSERT INTO beds (id, household_id, name, description, width_feet, length_feet, sort_order, created_at, updated_at, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)`,
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
        const dto = rowToDTO(existing);
        setVersionHeader(c, dto.version);
        return c.json({ ok: true, data: { bed: dto } });
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
      bed: {
        id, household_id: householdId,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        width_feet: parsed.data.width_feet ?? null,
        length_feet: parsed.data.length_feet ?? null,
        sort_order: sortOrder,
        created_at: now, updated_at: now, deleted_at: null,
        version: 1,
      } satisfies BedDTO,
    },
  });
});

bedRoutes.patch('/beds/:id', ...auth, async (c) => {
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
  if (parsed.data.description !== undefined) set('description', parsed.data.description ?? null);
  if (parsed.data.width_feet !== undefined) set('width_feet', parsed.data.width_feet ?? null);
  if (parsed.data.length_feet !== undefined) set('length_feet', parsed.data.length_feet ?? null);
  if (parsed.data.sort_order !== undefined) set('sort_order', parsed.data.sort_order);
  set('updated_at', Date.now());
  sets.push('version = version + 1');
  params.push(id, householdId);
  let where = `id = $${params.length - 1} AND household_id = $${params.length} AND deleted_at IS NULL`;
  if (expected !== null) {
    params.push(expected);
    where += ` AND version = $${params.length}`;
  }

  const updated = await dbGet<BedRow>(
    sql,
    `UPDATE beds SET ${sets.join(', ')} WHERE ${where} RETURNING ${SELECT_COLS}`,
    params,
  );
  if (!updated) {
    // Nothing matched. Missing or deleted is 404; a stale version is 409
    // with the current row so the client can merge and retry.
    const current = expected === null ? null : await dbGet<BedRow>(
      sql,
      `SELECT ${SELECT_COLS} FROM beds WHERE id = $1 AND household_id = $2 LIMIT 1`,
      [id, householdId],
    );
    if (!current || current.deleted_at !== null) {
      return c.json({ ok: false, error: { code: 'not_found', message: 'Bed not found' } }, 404);
    }
    return versionConflict(c, rowToDTO(current));
  }
  const dto = rowToDTO(updated);
  setVersionHeader(c, dto.version);
  return c.json({ ok: true, data: { bed: dto } });
});

bedRoutes.delete('/beds/:id', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const id = c.req.param('id');
  const sql = getSql(c.env);
  const expected = expectedVersion(c);
  if (expected === 'invalid') return invalidIfMatch(c);
  const now = Date.now();

  // One transaction for the tombstone and the whole cascade:
  //   bed → planting events → their journal entries
  //   bed → journal entries attached directly to the bed
  //   journal entry → checklist items and photo rows (hard-deleted)
  // Every tombstoned row gets version + 1 and updated_at = deleted_at = now.
  const outcome = await sql.begin(async (tx) => {
    // Lock the bed first. Planting-event creates take FOR SHARE on the bed,
    // so a concurrent create serializes with this delete.
    const bed = await dbGet<BedRow>(
      tx,
      `SELECT ${SELECT_COLS} FROM beds
        WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [id, householdId],
    );
    if (!bed) return { kind: 'not_found' as const };
    if (expected !== null && Number(bed.version) !== expected) {
      return { kind: 'conflict' as const, current: rowToDTO(bed) };
    }

    await dbRun(
      tx,
      `UPDATE beds SET deleted_at = $1, updated_at = $2, version = version + 1
        WHERE id = $3 AND household_id = $4`,
      [now, now, id, householdId],
    );

    // Journal entries under this bed: attached to one of its planting events
    // (active or already tombstoned, so the closure is complete) or directly
    // to the bed.
    const entryIds = (await dbAll<{ id: string }>(
      tx,
      `UPDATE journal_entries SET deleted_at = $1, updated_at = $2, version = version + 1
        WHERE household_id = $3 AND deleted_at IS NULL
          AND (bed_id = $4
               OR planting_event_id IN (
                 SELECT pe.id FROM planting_events pe
                  WHERE pe.bed_id = $4 AND pe.household_id = $3))
        RETURNING id`,
      [now, now, householdId, id],
    )).map((row) => row.id);

    let photoKeys: string[] = [];
    if (entryIds.length > 0) {
      await dbRun(
        tx,
        `DELETE FROM journal_checklist_items WHERE entry_id = ANY($1)`,
        [entryIds],
      );
      photoKeys = (await dbAll<{ storage_key: string }>(
        tx,
        `DELETE FROM journal_entry_photos WHERE entry_id = ANY($1) RETURNING storage_key`,
        [entryIds],
      )).map((row) => row.storage_key);
    }

    await dbRun(
      tx,
      `UPDATE planting_events SET deleted_at = $1, updated_at = $2, version = version + 1
        WHERE bed_id = $3 AND household_id = $4 AND deleted_at IS NULL`,
      [now, now, id, householdId],
    );

    return { kind: 'ok' as const, photoKeys };
  });

  if (outcome.kind === 'not_found') {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Bed not found' } }, 404);
  }
  if (outcome.kind === 'conflict') {
    return versionConflict(c, outcome.current);
  }

  // Photo objects are removed after commit, best-effort. A failure leaves an
  // orphaned object, never a half-applied cascade.
  const results = await Promise.allSettled(
    outcome.photoKeys.map((key) => deletePhoto(c.env, key)),
  );
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('bed cascade: photo object delete failed', result.reason);
    }
  }
  return c.json({ ok: true, data: { id, deleted_at: now } });
});
