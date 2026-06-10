import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { getSql } from '../db/client';
import { dbGet, dbAll, dbRun, isFkViolation } from '../db/helpers';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { validateAtMostOneAttach } from '../lib/journal/validation';
import { retrospectiveMmDdWindow, validateMmDd } from '../lib/journal/retrospective';
import { deletePhoto, getPhoto, isAllowedMime, newPhotoKey, putPhoto } from '../lib/storage';
import { parseDeltaQuery, buildDeltaPayload, deltaCursorWhere } from '../lib/sync';

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
  };
}

export const journalRoutes = new Hono<AppEnv>();

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
            planting_event_id, created_at, updated_at, deleted_at
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
            planting_event_id, created_at, updated_at, deleted_at
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
       FROM journal_entry_photos WHERE entry_id = $1 ORDER BY sort_order ASC, created_at ASC`,
    [entryId],
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
    `SELECT id, entry_id, text, completed, sort_order, updated_at
       FROM journal_checklist_items WHERE entry_id = $1 ORDER BY sort_order ASC`,
    [entryId],
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

  const id = nanoid();
  const now = Date.now();
  try {
    await dbRun(
      sql,
      `INSERT INTO journal_entries
         (id, household_id, occurred_on, body, seed_id, bed_id, planting_event_id,
          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [
        id, householdId, occurredOn, body.body ?? '',
        body.seed_id ?? null, body.bed_id ?? null, body.planting_event_id ?? null,
        now,
      ],
    );
  } catch (err) {
    if (isFkViolation(err)) {
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
            planting_event_id, created_at, updated_at, deleted_at
       FROM journal_entries WHERE id = $1`,
    [id],
  );
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

  // Validate at-most-one-attach against the MERGED row state, not just the
  // request payload — switching an attachment without nulling the other one
  // would otherwise pass the payload check but hit the DB CHECK as a 500.
  const existing = await dbGet<Pick<EntryRow, 'seed_id' | 'bed_id' | 'planting_event_id'>>(
    sql,
    `SELECT seed_id, bed_id, planting_event_id
       FROM journal_entries WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`,
    [id, householdId],
  );
  if (!existing) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'entry not found' } }, 404);
  }
  const mergedSeedId = 'seed_id' in body ? (body.seed_id ?? null) : existing.seed_id;
  const mergedBedId = 'bed_id' in body ? (body.bed_id ?? null) : existing.bed_id;
  const mergedEventId = 'planting_event_id' in body ? (body.planting_event_id ?? null) : existing.planting_event_id;
  const v = validateAtMostOneAttach({
    seed_id: mergedSeedId, bed_id: mergedBedId, planting_event_id: mergedEventId,
  });
  if (!v.ok) {
    return c.json({ ok: false, error: { code: 'bad_request', message: v.reason } }, 400);
  }

  const sets: string[] = ['updated_at = $1'];
  const params: unknown[] = [Date.now()];
  let p = 2;

  if ('body' in body) { sets.push(`body = $${p++}`); params.push(body.body ?? ''); }
  if ('occurred_on' in body) { sets.push(`occurred_on = $${p++}`); params.push(body.occurred_on); }
  if ('seed_id' in body) { sets.push(`seed_id = $${p++}`); params.push(body.seed_id ?? null); }
  if ('bed_id' in body) { sets.push(`bed_id = $${p++}`); params.push(body.bed_id ?? null); }
  if ('planting_event_id' in body) { sets.push(`planting_event_id = $${p++}`); params.push(body.planting_event_id ?? null); }

  params.push(id, householdId);
  try {
    await dbRun(
      sql,
      `UPDATE journal_entries SET ${sets.join(', ')}
         WHERE id = $${p++} AND household_id = $${p} AND deleted_at IS NULL`,
      params,
    );
  } catch (err) {
    if (isFkViolation(err)) {
      return c.json({
        ok: false,
        error: {
          code: 'invalid_reference',
          message:
            'A referenced seed, bed, or planting event does not exist on the server. Sync the parent records first, then retry this update.',
        },
      }, 400);
    }
    throw err;
  }

  const row = await dbGet<EntryRow>(
    sql,
    `SELECT id, household_id, occurred_on::text, body, seed_id, bed_id,
            planting_event_id, created_at, updated_at, deleted_at
       FROM journal_entries WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`,
    [id, householdId],
  );
  if (!row) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'entry not found' } }, 404);
  }
  return c.json({ ok: true, data: { entry: rowToDto(row) } });
});

// DELETE /api/journal/:id — soft-delete
journalRoutes.delete('/:id', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const id = c.req.param('id');
  const now = Date.now();
  await dbRun(
    sql,
    `UPDATE journal_entries SET deleted_at = $1, updated_at = $1
       WHERE id = $2 AND household_id = $3 AND deleted_at IS NULL`,
    [now, id, householdId],
  );
  return c.json({ ok: true, data: { id } });
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

  const owner = await dbGet<{ id: string }>(
    sql,
    `SELECT id FROM journal_entries
      WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [entryId, householdId],
  );
  if (!owner) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'entry not found' } }, 404);
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

  const key = newPhotoKey({
    householdId,
    scope: 'journal',
    ownerId: entryId,
    role: 'photo',
  });
  await putPhoto(c.env, key, body, mime!);

  // sort_order = max(existing) + 1 so new photos append in upload order.
  const maxRow = await dbGet<{ max: number | null }>(
    sql,
    `SELECT MAX(sort_order) AS max FROM journal_entry_photos WHERE entry_id = $1`,
    [entryId],
  );
  const sortOrder = (maxRow?.max ?? -1) + 1;

  const widthHeader = c.req.header('X-Photo-Width');
  const heightHeader = c.req.header('X-Photo-Height');
  const width = widthHeader ? parseInt(widthHeader, 10) || null : null;
  const height = heightHeader ? parseInt(heightHeader, 10) || null : null;

  const id = nanoid();
  const now = Date.now();
  await dbRun(
    sql,
    `INSERT INTO journal_entry_photos
       (id, entry_id, household_id, storage_key, sort_order, width, height, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
    [id, entryId, householdId, key, sortOrder, width, height, now],
  );

  // Bump the parent entry so delta-syncing clients pick up the photo.
  await dbRun(
    sql,
    `UPDATE journal_entries SET updated_at = $1 WHERE id = $2 AND household_id = $3`,
    [now, entryId, householdId],
  );

  const row = await dbGet<PhotoRow>(
    sql,
    `SELECT id, entry_id, household_id, storage_key, sort_order, width, height, created_at, updated_at
       FROM journal_entry_photos WHERE id = $1`,
    [id],
  );
  return c.json({ ok: true, data: { photo: photoToDto(row!) } });
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

  const photo = await dbGet<{ storage_key: string; entry_id: string }>(
    sql,
    `SELECT storage_key, entry_id FROM journal_entry_photos
      WHERE id = $1 AND household_id = $2`,
    [photoId, householdId],
  );
  if (!photo) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'photo not found' } }, 404);
  }

  await deletePhoto(c.env, photo.storage_key).catch(() => { /* best-effort */ });
  await dbRun(sql, `DELETE FROM journal_entry_photos WHERE id = $1`, [photoId]);
  await dbRun(
    sql,
    `UPDATE journal_entries SET updated_at = $1 WHERE id = $2 AND household_id = $3`,
    [Date.now(), photo.entry_id, householdId],
  );
  return c.json({ ok: true, data: { id: photoId } });
});

interface ChecklistRow {
  id: string;
  entry_id: string;
  text: string;
  completed: boolean;
  sort_order: number;
  updated_at: number;
}

function checklistToDto(c: ChecklistRow) {
  return {
    id: c.id, entryId: c.entry_id, text: c.text, completed: c.completed,
    sortOrder: c.sort_order, updatedAt: c.updated_at,
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

  const owner = await dbGet<{ id: string }>(
    sql,
    `SELECT id FROM journal_entries
      WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`,
    [entryId, householdId],
  );
  if (!owner) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'entry not found' } }, 404);
  }

  const maxRow = await dbGet<{ max: number | null }>(
    sql,
    `SELECT MAX(sort_order) AS max FROM journal_checklist_items WHERE entry_id = $1`,
    [entryId],
  );
  const sortOrder = (maxRow?.max ?? -1) + 1;
  const id = nanoid();
  const now = Date.now();

  await dbRun(
    sql,
    `INSERT INTO journal_checklist_items
       (id, entry_id, text, completed, sort_order, updated_at)
     VALUES ($1,$2,$3,FALSE,$4,$5)`,
    [id, entryId, body.text.trim(), sortOrder, now],
  );
  await dbRun(
    sql,
    `UPDATE journal_entries SET updated_at = $1 WHERE id = $2 AND household_id = $3`,
    [now, entryId, householdId],
  );

  const row = await dbGet<ChecklistRow>(
    sql,
    `SELECT id, entry_id, text, completed, sort_order, updated_at
       FROM journal_checklist_items WHERE id = $1`,
    [id],
  );
  return c.json({ ok: true, data: { item: checklistToDto(row!) } });
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

  // Confirm the item belongs to a household-owned, non-deleted entry.
  const owner = await dbGet<{ entry_id: string }>(
    sql,
    `SELECT ci.entry_id FROM journal_checklist_items ci
       JOIN journal_entries je ON je.id = ci.entry_id
      WHERE ci.id = $1 AND je.household_id = $2 AND je.deleted_at IS NULL`,
    [itemId, householdId],
  );
  if (!owner) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'item not found' } }, 404);
  }

  const sets: string[] = ['updated_at = $1'];
  const params: unknown[] = [Date.now()];
  let p = 2;
  if ('text' in body && typeof body.text === 'string' && body.text.trim()) {
    sets.push(`text = $${p++}`); params.push(body.text.trim());
  }
  if ('completed' in body && typeof body.completed === 'boolean') {
    sets.push(`completed = $${p++}`); params.push(body.completed);
  }
  if ('sort_order' in body && typeof body.sort_order === 'number') {
    sets.push(`sort_order = $${p++}`); params.push(body.sort_order);
  }
  params.push(itemId);
  await dbRun(
    sql,
    `UPDATE journal_checklist_items SET ${sets.join(', ')} WHERE id = $${p}`,
    params,
  );
  await dbRun(
    sql,
    `UPDATE journal_entries SET updated_at = $1 WHERE id = $2 AND household_id = $3`,
    [Date.now(), owner.entry_id, householdId],
  );

  const row = await dbGet<ChecklistRow>(
    sql,
    `SELECT id, entry_id, text, completed, sort_order, updated_at
       FROM journal_checklist_items WHERE id = $1`,
    [itemId],
  );
  return c.json({ ok: true, data: { item: checklistToDto(row!) } });
});

// DELETE /api/journal/checklist/:itemId
journalRoutes.delete('/checklist/:itemId', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const itemId = c.req.param('itemId');

  const owner = await dbGet<{ entry_id: string }>(
    sql,
    `SELECT ci.entry_id FROM journal_checklist_items ci
       JOIN journal_entries je ON je.id = ci.entry_id
      WHERE ci.id = $1 AND je.household_id = $2`,
    [itemId, householdId],
  );
  if (!owner) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'item not found' } }, 404);
  }
  await dbRun(sql, `DELETE FROM journal_checklist_items WHERE id = $1`, [itemId]);
  await dbRun(
    sql,
    `UPDATE journal_entries SET updated_at = $1 WHERE id = $2 AND household_id = $3`,
    [Date.now(), owner.entry_id, householdId],
  );
  return c.json({ ok: true, data: { id: itemId } });
});
