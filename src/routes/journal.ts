import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { getSql } from '../db/client';
import { dbGet, dbAll, dbRun, isFkViolation, isUniqueViolation, type Queryable } from '../db/helpers';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { validateAtMostOneAttach } from '../lib/journal/validation';
import { retrospectiveMmDdWindow, validateMmDd } from '../lib/journal/retrospective';
import { deletePhoto, getPhoto, isAllowedMime, newPhotoKey, putPhoto } from '../lib/storage';
import { parseDeltaQuery, buildDeltaPayload, deltaCursorWhere } from '../lib/sync';
import { expectedVersion, invalidIfMatch, setVersionHeader, versionConflict } from '../lib/versioning';

const auth = [requireAuth(), requireHousehold()] as const;

interface EntryRow {
  id: string;
  household_id: string;
  occurred_on: string;             // 'YYYY-MM-DD' from Postgres DATE
  body: string;
  seed_id: string | null;
  bed_id: string | null;
  planting_event_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  version: number;
}

function rowToDto(r: EntryRow) {
  return {
    id: r.id,
    householdId: r.household_id,
    occurredOn: r.occurred_on,
    body: r.body,
    seedId: r.seed_id,
    bedId: r.bed_id,
    plantingEventId: r.planting_event_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    version: r.version,
  };
}

export const journalRoutes = new Hono<AppEnv>();

async function lockJournalParents(q: Queryable, householdId: string, seedId: string | null, bedId: string | null, eventId: string | null): Promise<boolean> {
  for (const [table, id] of [['seeds', seedId], ['beds', bedId], ['planting_events', eventId]] as const) {
    if (!id) continue;
    const row = await dbGet<{ id: string }>(q,
      `SELECT id FROM ${table} WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR SHARE`, [id, householdId]);
    if (!row) return false;
  }
  return true;
}

// GET /api/journal?since=<ms>&limit=<n>&seed_id=&bed_id=&planting_event_id=&from_date=&to_date=
//
// Delta-sync friendly listing. When `since=0`, soft-deletes are hidden;
// any non-zero `since` includes deletes so clients can purge.
//
// Entity filters (seed_id/bed_id/planting_event_id) and date range
// (from_date/to_date on occurred_on) are optional and combine with AND.
// ORDER BY updated_at ASC matches the sync convention; clients re-sort
// for UI display.
journalRoutes.get('/', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const url = new URL(c.req.url);
  const query = parseDeltaQuery(url.searchParams);
  const seedId = url.searchParams.get('seed_id');
  const bedId = url.searchParams.get('bed_id');
  const eventId = url.searchParams.get('planting_event_id');
  const fromDate = url.searchParams.get('from_date');
  const toDate = url.searchParams.get('to_date');

  const cursor = deltaCursorWhere(query, 2);
  const wheres: string[] = ['household_id = $1', cursor.clause];
  const params: unknown[] = [householdId, ...cursor.params];
  let p = params.length + 1;
  if (query.since === 0) wheres.push('deleted_at IS NULL');
  if (seedId) { wheres.push(`seed_id = $${p++}`); params.push(seedId); }
  if (bedId) { wheres.push(`bed_id = $${p++}`); params.push(bedId); }
  if (eventId) { wheres.push(`planting_event_id = $${p++}`); params.push(eventId); }
  if (fromDate) { wheres.push(`occurred_on >= $${p++}`); params.push(fromDate); }
  if (toDate) { wheres.push(`occurred_on <= $${p++}`); params.push(toDate); }

  params.push(query.limit);
  const rows = await dbAll<EntryRow>(
    sql,
    `SELECT id, household_id, occurred_on::text, body, seed_id, bed_id,
            planting_event_id, created_at, updated_at, deleted_at, version
       FROM journal_entries
      WHERE ${wheres.join(' AND ')}
      ORDER BY updated_at ASC, id ASC
      LIMIT $${p}`,
    params,
  );

  // `buildDeltaPayload` requires items with snake_case `updated_at`, so we
  // wrap the raw rows then DTO-shape inside the payload.
  const payload = buildDeltaPayload(rows, query);
  return c.json({
    ok: true,
    data: {
      items: payload.items.map(rowToDto),
      cursor: payload.cursor,
      cursor_id: payload.cursor_id,
      has_more: payload.has_more,
    },
  });
});

// GET /api/journal/retrospective?on=MM-DD — year-grouped entries near anchor
journalRoutes.get('/retrospective', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const anchor = c.req.query('on');
  if (!anchor || !validateMmDd(anchor)) {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'on=MM-DD required' } }, 400);
  }

  const window = retrospectiveMmDdWindow(anchor);
  const rows = await dbAll<EntryRow>(
    sql,
    `SELECT id, household_id, occurred_on::text, body, seed_id, bed_id,
            planting_event_id, created_at, updated_at, deleted_at, version
       FROM journal_entries
      WHERE household_id = $1
        AND deleted_at IS NULL
        AND to_char(occurred_on, 'MM-DD') = ANY($2)
      ORDER BY occurred_on DESC, id DESC`,
    [householdId, window],
  );

  // Group by year, excluding the current year — the retrospective surfaces
  // what was happening on this MM-DD in *prior* years. The current year's
  // entry (if any) already shows in the main feed. Empty years are omitted
  // (the iOS card hides itself when the years array is empty — a first-year
  // gardener with zero history).
  const currentYear = new Date().getUTCFullYear();
  const byYear = new Map<number, ReturnType<typeof rowToDto>[]>();
  for (const r of rows) {
    const year = parseInt(r.occurred_on.slice(0, 4), 10);
    if (year >= currentYear) continue;
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year)!.push(rowToDto(r));
  }
  const years = Array.from(byYear.entries())
    .sort(([a], [b]) => b - a)
    .map(([year, entries]) => ({ year, entries }));

  return c.json({ ok: true, data: { anchor, years } });
});

// GET /api/journal/:id/photos — list photos for an entry. Mirrors the
// seed-photos pattern; lists children even when the parent entry is
// soft-deleted so client cleanup flows can resolve attached photos.
journalRoutes.get('/:id/photos', ...auth, async (c) => {
  const householdId = c.get('householdId') as string;
  const entryId = c.req.param('id');
  const sql = getSql(c.env);
  const owner = await dbGet<{ id: string }>(
    sql,
    `SELECT id FROM journal_entries WHERE id = $1 AND household_id = $2`,
    [entryId, householdId],
  );
  if (!owner) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'entry not found' } }, 404);
  }
  const photos = await dbAll<PhotoRow>(
    sql,
    `SELECT id, entry_id, household_id, storage_key, sort_order, width, height, created_at, updated_at
       FROM journal_entry_photos WHERE entry_id = $1 AND household_id = $2 ORDER BY sort_order ASC, created_at ASC`,
    [entryId, householdId],
  );
  return c.json({ ok: true, data: { photos: photos.map(photoToDto) } });
});

// GET /api/journal/:id/checklist — list checklist items for an entry.
journalRoutes.get('/:id/checklist', ...auth, async (c) => {
  const householdId = c.get('householdId') as string;
  const entryId = c.req.param('id');
  const sql = getSql(c.env);
  const owner = await dbGet<{ id: string }>(
    sql,
    `SELECT id FROM journal_entries WHERE id = $1 AND household_id = $2`,
    [entryId, householdId],
  );
  if (!owner) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'entry not found' } }, 404);
  }
  const items = await dbAll<ChecklistRow>(
    sql,
    `SELECT ci.id, ci.entry_id, ci.text, ci.completed, ci.sort_order, ci.updated_at, ci.version
       FROM journal_checklist_items ci JOIN journal_entries je ON je.id = ci.entry_id
      WHERE ci.entry_id = $1 AND je.household_id = $2 ORDER BY sort_order ASC`,
    [entryId, householdId],
  );
  return c.json({ ok: true, data: { items: items.map(checklistToDto) } });
});

// POST /api/journal — create an entry
journalRoutes.post('/', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'JSON body required' } }, 400);
  }
  const v = validateAtMostOneAttach(body);
  if (!v.ok) {
    return c.json({ ok: false, error: { code: 'bad_request', message: v.reason } }, 400);
  }
  const occurredOn = typeof body.occurred_on === 'string' ? body.occurred_on : null;
  if (!occurredOn || !/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'occurred_on must be YYYY-MM-DD' } }, 400);
  }

  if ('id' in body && (typeof body.id !== 'string' || body.id.length < 1 || body.id.length > 80)) {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'id must be 1 to 80 characters' } }, 400);
  }
  const id = typeof body.id === 'string' ? body.id : nanoid();
  const now = Date.now();
  if (typeof body.id === 'string') {
    const existing = await dbGet<EntryRow>(sql,
      `SELECT id, household_id, occurred_on::text, body, seed_id, bed_id, planting_event_id,
              created_at, updated_at, deleted_at, version FROM journal_entries WHERE id = $1 AND household_id = $2`, [id, householdId]);
    if (existing) {
      setVersionHeader(c, existing.version);
      return c.json({ ok: true, data: { entry: rowToDto(existing) } });
    }
    if (await dbGet(sql, `SELECT id FROM journal_entries WHERE id = $1`, [id])) return c.json({ ok: false, error: { code: 'conflict', message: 'A record with this id already exists.' } }, 409);
  }
  try {
    await sql.begin(async (tx) => {
      if (!await lockJournalParents(tx, householdId, body.seed_id ?? null, body.bed_id ?? null, body.planting_event_id ?? null)) throw new Error('invalid_reference');
      await dbRun(tx,
        `INSERT INTO journal_entries
           (id, household_id, occurred_on, body, seed_id, bed_id, planting_event_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
        [id, householdId, occurredOn, body.body ?? '', body.seed_id ?? null, body.bed_id ?? null, body.planting_event_id ?? null, now]);
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await dbGet<EntryRow>(sql,
        `SELECT id, household_id, occurred_on::text, body, seed_id, bed_id, planting_event_id,
                created_at, updated_at, deleted_at, version FROM journal_entries WHERE id = $1 AND household_id = $2`, [id, householdId]);
      if (existing) {
        setVersionHeader(c, existing.version);
        return c.json({ ok: true, data: { entry: rowToDto(existing) } });
      }
      return c.json({ ok: false, error: { code: 'conflict', message: 'A record with this id already exists.' } }, 409);
    }
    if (isFkViolation(err) || (err instanceof Error && err.message === 'invalid_reference')) {
      return c.json({
        ok: false,
        error: {
          code: 'invalid_reference',
          message:
            'A referenced seed, bed, or planting event does not exist on the server. Sync the parent records first, then retry this entry.',
        },
      }, 400);
    }
    throw err;
  }

  const row = await dbGet<EntryRow>(
    sql,
    `SELECT id, household_id, occurred_on::text, body, seed_id, bed_id,
            planting_event_id, created_at, updated_at, deleted_at, version
       FROM journal_entries WHERE id = $1`,
    [id],
  );
  setVersionHeader(c, row!.version);
  return c.json({ ok: true, data: { entry: rowToDto(row!) } });
});

// PATCH /api/journal/:id — update body / occurred_on / parent ref
journalRoutes.patch('/:id', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'JSON body required' } }, 400);
  }
  if ('occurred_on' in body && body.occurred_on != null) {
    if (typeof body.occurred_on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.occurred_on)) {
      return c.json(
        { ok: false, error: { code: 'bad_request', message: 'occurred_on must be YYYY-MM-DD' } },
        400,
      );
    }
  }

  const expected = expectedVersion(c);
  if (expected === 'invalid') return invalidIfMatch(c);
  const now = Date.now();
  const names = ['body', 'occurred_on', 'seed_id', 'bed_id', 'planting_event_id'].filter((k) => k in body);
  const vals = names.map((k) => k === 'body' ? (body[k] ?? '') : (body[k] ?? null));
  const sets = names.map((k, i) => `${k} = $${i + 1}`);
  sets.push(`updated_at = $${names.length + 1}`, 'version = version + 1');
  const params: unknown[] = [...vals, now, id, householdId];
  let where = `id = $${names.length + 2} AND household_id = $${names.length + 3} AND deleted_at IS NULL`;
  if (expected !== null) { params.push(expected); where += ` AND version = $${params.length}`; }
  let outcome: { row: EntryRow | null; current: EntryRow | null };
  try {
    outcome = await sql.begin(async (tx) => {
      const snapshot = await dbGet<EntryRow>(tx,
        `SELECT id, household_id, occurred_on::text, body, seed_id, bed_id, planting_event_id,
                created_at, updated_at, deleted_at, version FROM journal_entries
          WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`, [id, householdId]);
      if (!snapshot) return { row: null, current: null };
      const snapshotRefs = {
        seed_id: 'seed_id' in body ? body.seed_id ?? null : snapshot.seed_id,
        bed_id: 'bed_id' in body ? body.bed_id ?? null : snapshot.bed_id,
        planting_event_id: 'planting_event_id' in body ? body.planting_event_id ?? null : snapshot.planting_event_id,
      };
      const snapshotCheck = validateAtMostOneAttach(snapshotRefs);
      if (!snapshotCheck.ok) throw Object.assign(new Error(snapshotCheck.reason), { code: 'JOURNAL_ATTACH_INVALID' });
      if (!await lockJournalParents(tx, householdId,
        'seed_id' in body ? snapshotRefs.seed_id : null,
        'bed_id' in body ? snapshotRefs.bed_id : null,
        'planting_event_id' in body ? snapshotRefs.planting_event_id : null)) throw new Error('invalid_reference');
      const existing = await dbGet<EntryRow>(tx,
        `SELECT id, household_id, occurred_on::text, body, seed_id, bed_id, planting_event_id,
                created_at, updated_at, deleted_at, version FROM journal_entries
          WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, householdId]);
      if (!existing) return { row: null, current: null };
      const merged = {
        seed_id: 'seed_id' in body ? body.seed_id ?? null : existing.seed_id,
        bed_id: 'bed_id' in body ? body.bed_id ?? null : existing.bed_id,
        planting_event_id: 'planting_event_id' in body ? body.planting_event_id ?? null : existing.planting_event_id,
      };
      const v = validateAtMostOneAttach(merged);
      if (!v.ok) throw Object.assign(new Error(v.reason), { code: 'JOURNAL_ATTACH_INVALID' });
      const changed = await tx.unsafe<{ id: string }[]>(
        `UPDATE journal_entries SET ${sets.join(', ')} WHERE ${where} RETURNING *`, params as never);
      const load = () => dbGet<EntryRow>(tx,
        `SELECT id, household_id, occurred_on::text, body, seed_id, bed_id, planting_event_id,
                created_at, updated_at, deleted_at, version FROM journal_entries
          WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`, [id, householdId]);
      return changed[0] ? { row: await load(), current: null } : { row: null, current: await load() };
    });
  } catch (err) {
    if (isFkViolation(err) || (err instanceof Error && err.message === 'invalid_reference')) return c.json({ ok: false, error: { code: 'invalid_reference', message: 'A referenced seed, bed, or planting event does not exist in this household.' } }, 400);
    if (err instanceof Error && 'code' in err && err.code === 'JOURNAL_ATTACH_INVALID') return c.json({ ok: false, error: { code: 'bad_request', message: err.message } }, 400);
    throw err;
  }
  if (!outcome!.row) {
    if (!outcome!.current) return c.json({ ok: false, error: { code: 'not_found', message: 'entry not found' } }, 404);
    if (expected !== null) return versionConflict(c, rowToDto(outcome!.current));
    return c.json({ ok: false, error: { code: 'not_found', message: 'entry not found' } }, 404);
  }
  setVersionHeader(c, outcome!.row.version);
  return c.json({ ok: true, data: { entry: rowToDto(outcome!.row) } });
});

// DELETE /api/journal/:id — soft-delete
journalRoutes.delete('/:id', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const id = c.req.param('id');
  const expected = expectedVersion(c);
  if (expected === 'invalid') return invalidIfMatch(c);
  const now = Date.now();
  const result = await sql.begin(async (tx) => {
    const current = await dbGet<EntryRow>(tx,
      `SELECT id, household_id, occurred_on::text, body, seed_id, bed_id, planting_event_id,
              created_at, updated_at, deleted_at, version FROM journal_entries
        WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, householdId]);
    if (!current) return { current: null, version: null, keys: [] as string[] };
    const changed = await tx.unsafe<{ version: number }[]>(
      `UPDATE journal_entries SET deleted_at = $1, updated_at = $1, version = version + 1
        WHERE id = $2 AND household_id = $3 AND deleted_at IS NULL${expected === null ? '' : ' AND version = $4'} RETURNING version`,
      expected === null ? [now, id, householdId] : [now, id, householdId, expected]);
    if (!changed[0]) return { current, version: null, keys: [] as string[] };
    const photos = await tx.unsafe<{ storage_key: string }[]>(
      `SELECT storage_key FROM journal_entry_photos WHERE entry_id = $1 AND household_id = $2`, [id, householdId]);
    await tx.unsafe(`DELETE FROM journal_entry_photos WHERE entry_id = $1 AND household_id = $2`, [id, householdId]);
    await tx.unsafe(`DELETE FROM journal_checklist_items WHERE entry_id = $1`, [id]);
    return { current: null, version: changed[0].version, keys: photos.map((p) => p.storage_key) };
  });
  if (result.current) {
    if (expected !== null) return versionConflict(c, rowToDto(result.current));
    return c.json({ ok: false, error: { code: 'not_found', message: 'entry not found' } }, 404);
  }
  if (result.version === null) return c.json({ ok: false, error: { code: 'not_found', message: 'entry not found' } }, 404);
  await Promise.allSettled(result.keys.map((key) => deletePhoto(c.env, key)));
  setVersionHeader(c, result.version);
  return c.json({ ok: true, data: { id, deleted_at: now, version: result.version } });
});

// ---------------------------------------------------------------------------
// Photo routes — direct-bytes upload mirroring src/routes/photos.ts.
// Journal photos live in their own table (journal_entry_photos) but share
// the S3 bucket; the storage helper uses scope='journal' to keep keys in a
// distinct prefix.
// ---------------------------------------------------------------------------

interface PhotoRow {
  id: string;
  entry_id: string;
  household_id: string;
  storage_key: string;
  sort_order: number;
  width: number | null;
  height: number | null;
  created_at: number;
  updated_at: number;
}

function photoToDto(p: PhotoRow) {
  return {
    id: p.id,
    entryId: p.entry_id,
    storageKey: p.storage_key,
    sortOrder: p.sort_order,
    width: p.width,
    height: p.height,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

// POST /api/journal/:id/photos — upload a photo to a journal entry.
// Direct-bytes upload: the request body is the raw image bytes and the
// Content-Type header carries the MIME. X-Photo-Width / X-Photo-Height
// optionally convey client-computed dimensions.
journalRoutes.post('/:id/photos', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const entryId = c.req.param('id');

  const idParam = c.req.query('id');
  if (idParam !== undefined && (idParam.length < 1 || idParam.length > 80)) return c.json({ ok: false, error: { code: 'bad_request', message: 'id must be 1 to 80 characters' } }, 400);
  if (idParam) {
    const replay = await dbGet<PhotoRow>(sql, `SELECT id, entry_id, household_id, storage_key, sort_order, width, height, created_at, updated_at
      FROM journal_entry_photos WHERE id = $1 AND household_id = $2`, [idParam, householdId]);
    if (replay) {
      if (replay.entry_id !== entryId) return c.json({ ok: false, error: { code: 'conflict', message: 'A record with this id already exists.' } }, 409);
      const parent = await dbGet<{ version: number }>(sql, `SELECT version FROM journal_entries WHERE id = $1 AND household_id = $2`, [replay.entry_id, householdId]);
      if (parent) setVersionHeader(c, parent.version);
      return c.json({ ok: true, data: { photo: photoToDto(replay) } });
    }
    if (await dbGet(sql, `SELECT id FROM journal_entry_photos WHERE id = $1`, [idParam])) return c.json({ ok: false, error: { code: 'conflict', message: 'A record with this id already exists.' } }, 409);
  }

  const mime = c.req.header('Content-Type');
  if (!isAllowedMime(mime)) {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'Unsupported Content-Type' } }, 400);
  }

  // Cap the upload at 10 MB. Photos compress well under 1MB after the
  // iOS resize pass; this is abuse prevention.
  const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
  const declaredLength = Number(c.req.header('Content-Length') ?? '0');
  if (declaredLength > MAX_PHOTO_BYTES) {
    return c.json({ ok: false, error: { code: 'payload_too_large',
      message: `Photo too large (${declaredLength} bytes). Max ${MAX_PHOTO_BYTES}.` } }, 413);
  }
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'Empty body' } }, 400);
  }
  if (body.byteLength > MAX_PHOTO_BYTES) {
    return c.json({ ok: false, error: { code: 'payload_too_large',
      message: `Photo too large (${body.byteLength} bytes). Max ${MAX_PHOTO_BYTES}.` } }, 413);
  }

  const id = idParam ?? nanoid();
  const now = Date.now();
  const key = newPhotoKey({
    householdId,
    scope: 'journal',
    ownerId: entryId,
    role: 'photo',
  });
  const widthHeader = c.req.header('X-Photo-Width');
  const heightHeader = c.req.header('X-Photo-Height');
  const width = widthHeader ? parseInt(widthHeader, 10) || null : null;
  const height = heightHeader ? parseInt(heightHeader, 10) || null : null;
  let uploadAttempted = false;

  const row = await sql.begin(async (tx) => {
    const parent = await dbGet<{ id: string }>(tx, `SELECT id FROM journal_entries WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`, [entryId, householdId]);
    if (!parent) throw new Error('JOURNAL_ENTRY_NOT_FOUND');
    const collision = await dbGet<{ household_id: string }>(tx, `SELECT household_id FROM journal_entry_photos WHERE id = $1`, [id]);
    if (collision) throw new Error(collision.household_id === householdId ? 'JOURNAL_PHOTO_REPLAY_RACE' : 'JOURNAL_PHOTO_CONFLICT');
    const maxRow = await dbGet<{ max: number | null }>(tx, `SELECT MAX(sort_order) AS max FROM journal_entry_photos WHERE entry_id = $1 AND household_id = $2`, [entryId, householdId]);
    const sortOrder = (maxRow?.max ?? -1) + 1;
    uploadAttempted = true;
    await putPhoto(c.env, key, body, mime!);
    await dbRun(tx, `INSERT INTO journal_entry_photos
      (id, entry_id, household_id, storage_key, sort_order, width, height, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`, [id, entryId, householdId, key, sortOrder, width, height, now]);
    const bumped = await tx.unsafe<{ version: number }[]>(`UPDATE journal_entries SET updated_at = $1, version = version + 1
      WHERE id = $2 AND household_id = $3 RETURNING version`, [now, entryId, householdId]);
    return { photo: await dbGet<PhotoRow>(tx, `SELECT id, entry_id, household_id, storage_key, sort_order, width, height, created_at, updated_at
      FROM journal_entry_photos WHERE id = $1 AND household_id = $2`, [id, householdId]), version: bumped[0]!.version };
  }).catch(async (err) => {
    if (uploadAttempted) await deletePhoto(c.env, key).catch(() => {});
    if (err instanceof Error && err.message === 'JOURNAL_PHOTO_REPLAY_RACE') {
      const existing = await dbGet<PhotoRow>(sql, `SELECT id, entry_id, household_id, storage_key, sort_order, width, height, created_at, updated_at
        FROM journal_entry_photos WHERE id = $1 AND household_id = $2`, [id, householdId]);
      if (existing) {
        if (existing.entry_id !== entryId) return { conflict: true as const };
        const parent = await dbGet<{ version: number }>(sql,
          `SELECT version FROM journal_entries WHERE id = $1 AND household_id = $2`, [existing.entry_id, householdId]);
        return { photo: existing, version: parent?.version ?? null };
      }
    }
    if (isUniqueViolation(err)) {
      const existing = await dbGet<PhotoRow>(sql, `SELECT id, entry_id, household_id, storage_key, sort_order, width, height, created_at, updated_at
        FROM journal_entry_photos WHERE id = $1 AND household_id = $2`, [id, householdId]);
      if (existing) {
        if (existing.entry_id !== entryId) return { conflict: true as const };
        const parent = await dbGet<{ version: number }>(sql,
          `SELECT version FROM journal_entries WHERE id = $1 AND household_id = $2`, [existing.entry_id, householdId]);
        return { photo: existing, version: parent?.version ?? null };
      }
      return { conflict: true as const };
    }
    if (err instanceof Error && err.message === 'JOURNAL_PHOTO_CONFLICT') return { conflict: true as const };
    if (err instanceof Error && err.message === 'JOURNAL_ENTRY_NOT_FOUND') return { missing: true as const };
    throw err;
  });
  if ('conflict' in row) return c.json({ ok: false, error: { code: 'conflict', message: 'A record with this id already exists.' } }, 409);
  if ('missing' in row) return c.json({ ok: false, error: { code: 'invalid_reference', message: 'Journal entry does not exist in this household.' } }, 400);
  if (!row.photo) return c.json({ ok: false, error: { code: 'not_found', message: 'entry not found' } }, 404);
  if (row.version !== null) setVersionHeader(c, row.version);
  return c.json({ ok: true, data: { photo: photoToDto(row.photo) } });
});

// GET /api/journal/photos/:photoId — fetch the photo binary. Mirrors
// the seed-photos download endpoint.
journalRoutes.get('/photos/:photoId', ...auth, async (c) => {
  const householdId = c.get('householdId') as string;
  const photoId = c.req.param('photoId');
  const sql = getSql(c.env);
  const photo = await dbGet<{ storage_key: string }>(
    sql,
    `SELECT storage_key FROM journal_entry_photos
      WHERE id = $1 AND household_id = $2 LIMIT 1`,
    [photoId, householdId],
  );
  if (!photo) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'photo not found' } }, 404);
  }
  const obj = await getPhoto(c.env, photo.storage_key);
  if (!obj) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'photo data missing' } }, 404);
  }
  return new Response(obj.bytes, {
    status: 200,
    headers: {
      'Content-Type': obj.contentType,
      'Cache-Control': 'private, max-age=3600',
    },
  });
});

// DELETE /api/journal/photos/:photoId — remove a photo (storage + row).
// Intentionally does NOT check the parent entry's deleted_at: soft-deleted
// entries' photos can still be tidied up by the client.
journalRoutes.delete('/photos/:photoId', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const photoId = c.req.param('photoId');

  const result = await sql.begin(async (tx) => {
    const snapshot = await dbGet<{ entry_id: string }>(tx,
      `SELECT entry_id FROM journal_entry_photos WHERE id = $1 AND household_id = $2`, [photoId, householdId]);
    if (!snapshot) return null;
    await dbGet(tx, `SELECT id FROM journal_entries WHERE id = $1 AND household_id = $2 FOR UPDATE`, [snapshot.entry_id, householdId]);
    const photo = await dbGet<{ storage_key: string; entry_id: string }>(tx,
      `SELECT storage_key, entry_id FROM journal_entry_photos WHERE id = $1 AND household_id = $2 FOR UPDATE`, [photoId, householdId]);
    if (!photo) return null;
    await dbRun(tx, `DELETE FROM journal_entry_photos WHERE id = $1 AND household_id = $2`, [photoId, householdId]);
    const bumped = await tx.unsafe<{ version: number }[]>(`UPDATE journal_entries SET updated_at = $1, version = version + 1
      WHERE id = $2 AND household_id = $3 RETURNING version`, [Date.now(), photo.entry_id, householdId]);
    return { photo, version: bumped[0]?.version ?? null };
  });
  if (!result) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'photo not found' } }, 404);
  }
  await deletePhoto(c.env, result.photo.storage_key).catch(() => { /* best-effort */ });
  if (result.version !== null) setVersionHeader(c, result.version);
  return c.json({ ok: true, data: { id: photoId } });
});

interface ChecklistRow {
  id: string;
  entry_id: string;
  text: string;
  completed: boolean;
  sort_order: number;
  updated_at: number;
  version: number;
}

function checklistToDto(c: ChecklistRow) {
  return {
    id: c.id, entryId: c.entry_id, text: c.text, completed: c.completed,
    sortOrder: c.sort_order, updatedAt: c.updated_at, version: c.version,
  };
}

// POST /api/journal/:id/checklist — add an item
journalRoutes.post('/:id/checklist', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const entryId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.text !== 'string' || !body.text.trim()) {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'text required' } }, 400);
  }

  if ('id' in body && (typeof body.id !== 'string' || body.id.length < 1 || body.id.length > 80)) {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'id must be 1 to 80 characters' } }, 400);
  }
  const id = typeof body.id === 'string' ? body.id : nanoid();
  const now = Date.now();
  if (typeof body.id === 'string') {
    const replay = await dbGet<ChecklistRow>(sql,
      `SELECT ci.id, ci.entry_id, ci.text, ci.completed, ci.sort_order, ci.updated_at, ci.version
         FROM journal_checklist_items ci JOIN journal_entries je ON je.id = ci.entry_id
        WHERE ci.id = $1 AND je.household_id = $2`, [id, householdId]);
    if (replay) {
      if (replay.entry_id !== entryId) return c.json({ ok: false, error: { code: 'conflict', message: 'A record with this id already exists.' } }, 409);
      setVersionHeader(c, replay.version);
      return c.json({ ok: true, data: { item: checklistToDto(replay) } });
    }
    if (await dbGet(sql, `SELECT id FROM journal_checklist_items WHERE id = $1`, [id])) return c.json({ ok: false, error: { code: 'conflict', message: 'A record with this id already exists.' } }, 409);
  }
  let result: {
    missing: boolean; row: ChecklistRow | null; version: number | null;
    replay?: boolean; conflict?: boolean;
  };
  try {
  result = await sql.begin(async (tx) => {
    const parent = await dbGet<{ id: string; version: number }>(tx,
      `SELECT id, version FROM journal_entries WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`, [entryId, householdId]);
    if (!parent) return { missing: true as const, row: null as ChecklistRow | null, version: null as number | null };
    const replay = await dbGet<ChecklistRow>(tx,
      `SELECT ci.id, ci.entry_id, ci.text, ci.completed, ci.sort_order, ci.updated_at, ci.version
         FROM journal_checklist_items ci JOIN journal_entries je ON je.id = ci.entry_id
        WHERE ci.id = $1 AND je.household_id = $2`, [id, householdId]);
    if (replay) {
      if (replay.entry_id !== entryId) return { missing: false as const, row: null, version: null, conflict: true as const };
      return { missing: false as const, row: replay, version: parent.version, replay: true };
    }
    const globallyTaken = await dbGet<{ id: string }>(tx, `SELECT id FROM journal_checklist_items WHERE id = $1`, [id]);
    if (globallyTaken) return { missing: false as const, row: null, version: null, conflict: true };
    const max = await dbGet<{ max: number | null }>(tx, `SELECT MAX(sort_order) AS max FROM journal_checklist_items WHERE entry_id = $1`, [entryId]);
    await dbRun(tx, `INSERT INTO journal_checklist_items (id, entry_id, text, completed, sort_order, updated_at)
      VALUES ($1,$2,$3,FALSE,$4,$5)`, [id, entryId, body.text.trim(), (max?.max ?? -1) + 1, now]);
    const bumped = await tx.unsafe<{ version: number }[]>(`UPDATE journal_entries SET updated_at = $1, version = version + 1
      WHERE id = $2 AND household_id = $3 RETURNING version`, [now, entryId, householdId]);
    const row = await dbGet<ChecklistRow>(tx, `SELECT id, entry_id, text, completed, sort_order, updated_at, version
      FROM journal_checklist_items WHERE id = $1`, [id]);
    return { missing: false as const, row, version: bumped[0]!.version, replay: false };
  });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const replay = await dbGet<ChecklistRow>(sql,
      `SELECT ci.id, ci.entry_id, ci.text, ci.completed, ci.sort_order, ci.updated_at, ci.version
         FROM journal_checklist_items ci JOIN journal_entries je ON je.id = ci.entry_id
        WHERE ci.id = $1 AND je.household_id = $2`, [id, householdId]);
    if (!replay || replay.entry_id !== entryId) return c.json({ ok: false, error: { code: 'conflict', message: 'A record with this id already exists.' } }, 409);
    result = { missing: false, row: replay, version: replay.version, replay: true };
  }
  if (result.missing) return c.json({ ok: false, error: { code: 'invalid_reference', message: 'Journal entry does not exist in this household.' } }, 400);
  if ('conflict' in result) return c.json({ ok: false, error: { code: 'conflict', message: 'A record with this id already exists.' } }, 409);
  if (!result.row) return c.json({ ok: false, error: { code: 'not_found', message: 'entry not found' } }, 404);
  setVersionHeader(c, result.row.version);
  return c.json({ ok: true, data: { item: checklistToDto(result.row) } });
});

// PATCH /api/journal/checklist/:itemId — toggle completed or edit text
journalRoutes.patch('/checklist/:itemId', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const itemId = c.req.param('itemId');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'JSON body required' } }, 400);
  }

  const expected = expectedVersion(c);
  if (expected === 'invalid') return invalidIfMatch(c);
  const now = Date.now();
  const columns: Record<string, unknown> = {};
  if ('text' in body && typeof body.text === 'string' && body.text.trim()) columns.text = body.text.trim();
  if ('completed' in body && typeof body.completed === 'boolean') columns.completed = body.completed;
  if ('sort_order' in body && typeof body.sort_order === 'number') columns.sort_order = body.sort_order;
  const names = Object.keys(columns);
  const sets = names.map((key, i) => `${key} = $${i + 1}`);
  sets.push(`updated_at = $${names.length + 1}`, 'version = version + 1');
  const params: unknown[] = [...names.map((key) => columns[key]), now, itemId, householdId];
  let where = `ci.id = $${names.length + 2} AND EXISTS (SELECT 1 FROM journal_entries je WHERE je.id = ci.entry_id AND je.household_id = $${names.length + 3} AND je.deleted_at IS NULL)`;
  if (expected !== null) { params.push(expected); where += ` AND version = $${params.length}`; }
  const result = await sql.begin(async (tx) => {
    const link = await dbGet<{ entry_id: string }>(tx, `SELECT ci.entry_id FROM journal_checklist_items ci
      JOIN journal_entries je ON je.id = ci.entry_id WHERE ci.id = $1 AND je.household_id = $2 AND je.deleted_at IS NULL`, [itemId, householdId]);
    if (!link) return { missing: true as const, row: null as ChecklistRow | null, current: null as ChecklistRow | null };
    await dbGet(tx, `SELECT id FROM journal_entries WHERE id = $1 AND household_id = $2 FOR UPDATE`, [link.entry_id, householdId]);
    await dbGet(tx, `SELECT id FROM journal_checklist_items WHERE id = $1 FOR UPDATE`, [itemId]);
    const changed = await tx.unsafe<{ id: string }[]>(`UPDATE journal_checklist_items AS ci SET ${sets.join(', ')} WHERE ${where} RETURNING *`, params as never);
    const load = () => dbGet<ChecklistRow>(tx, `SELECT id, entry_id, text, completed, sort_order, updated_at, version
      FROM journal_checklist_items WHERE id = $1`, [itemId]);
    if (!changed[0]) return { missing: false as const, row: null, current: await load() };
    await dbRun(tx, `UPDATE journal_entries SET updated_at = $1, version = version + 1 WHERE id = $2 AND household_id = $3`, [now, link.entry_id, householdId]);
    return { missing: false as const, row: await load(), current: null };
  });
  if (result.missing) return c.json({ ok: false, error: { code: 'not_found', message: 'item not found' } }, 404);
  if (!result.row) {
    if (result.current && expected !== null) return versionConflict(c, checklistToDto(result.current));
    return c.json({ ok: false, error: { code: 'not_found', message: 'item not found' } }, 404);
  }
  setVersionHeader(c, result.row.version);
  return c.json({ ok: true, data: { item: checklistToDto(result.row) } });
});

// DELETE /api/journal/checklist/:itemId
journalRoutes.delete('/checklist/:itemId', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const itemId = c.req.param('itemId');

  const expected = expectedVersion(c);
  if (expected === 'invalid') return invalidIfMatch(c);
  const now = Date.now();
  const result = await sql.begin(async (tx) => {
    const owner = await dbGet<{ entry_id: string }>(tx, `SELECT ci.entry_id FROM journal_checklist_items ci
      JOIN journal_entries je ON je.id = ci.entry_id WHERE ci.id = $1 AND je.household_id = $2`, [itemId, householdId]);
    if (!owner) return { missing: true as const, current: null as ChecklistRow | null, deleted: false };
    await dbGet(tx, `SELECT id FROM journal_entries WHERE id = $1 AND household_id = $2 FOR UPDATE`, [owner.entry_id, householdId]);
    const current = await dbGet<ChecklistRow>(tx, `SELECT id, entry_id, text, completed, sort_order, updated_at, version
      FROM journal_checklist_items WHERE id = $1 FOR UPDATE`, [itemId]);
    if (!current) return { missing: true as const, current: null, deleted: false };
    if (expected !== null && current.version !== expected) return { missing: false as const, current, deleted: false };
    await dbRun(tx, `DELETE FROM journal_checklist_items WHERE id = $1`, [itemId]);
    const parent = await tx.unsafe<{ version: number }[]>(`UPDATE journal_entries SET updated_at = $1, version = version + 1
      WHERE id = $2 AND household_id = $3 RETURNING version`, [now, owner.entry_id, householdId]);
    return { missing: false as const, current: null, deleted: true, parentVersion: parent[0]!.version };
  });
  if (result.missing) return c.json({ ok: false, error: { code: 'not_found', message: 'item not found' } }, 404);
  if (result.current) return versionConflict(c, checklistToDto(result.current));
  if (!result.deleted) return c.json({ ok: false, error: { code: 'not_found', message: 'item not found' } }, 404);
  setVersionHeader(c, result.parentVersion!);
  return c.json({ ok: true, data: { id: itemId, deleted: true } });
});
