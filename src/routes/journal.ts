import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { getSql } from '../db/client';
import { dbGet, dbAll, dbRun } from '../db/helpers';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { validateAtMostOneAttach } from '../lib/journal/validation';
import { deletePhoto, isAllowedMime, newPhotoKey, putPhoto } from '../lib/storage';

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

// GET /api/journal — paginated chronological feed
journalRoutes.get('/', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const seedId = c.req.query('seed_id');
  const bedId = c.req.query('bed_id');
  const eventId = c.req.query('planting_event_id');
  const fromDate = c.req.query('from_date');
  const toDate = c.req.query('to_date');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 200);

  const conditions: string[] = ['household_id = $1', 'deleted_at IS NULL'];
  const params: unknown[] = [householdId];
  let p = 2;

  if (seedId) { conditions.push(`seed_id = $${p++}`); params.push(seedId); }
  if (bedId) { conditions.push(`bed_id = $${p++}`); params.push(bedId); }
  if (eventId) { conditions.push(`planting_event_id = $${p++}`); params.push(eventId); }
  if (fromDate) { conditions.push(`occurred_on >= $${p++}`); params.push(fromDate); }
  if (toDate) { conditions.push(`occurred_on <= $${p++}`); params.push(toDate); }

  params.push(limit);
  const rows = await dbAll<EntryRow>(
    sql,
    `SELECT id, household_id, occurred_on::text, body, seed_id, bed_id,
            planting_event_id, created_at, updated_at, deleted_at
       FROM journal_entries
      WHERE ${conditions.join(' AND ')}
      ORDER BY occurred_on DESC, id DESC
      LIMIT $${p}`,
    params,
  );

  return c.json({ ok: true, data: { entries: rows.map(rowToDto) } });
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
  const v = validateAtMostOneAttach({
    seed_id: body.seed_id, bed_id: body.bed_id, planting_event_id: body.planting_event_id,
  });
  if (!v.ok) {
    return c.json({ ok: false, error: { code: 'bad_request', message: v.reason } }, 400);
  }
  if ('occurred_on' in body && body.occurred_on != null) {
    if (typeof body.occurred_on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.occurred_on)) {
      return c.json(
        { ok: false, error: { code: 'bad_request', message: 'occurred_on must be YYYY-MM-DD' } },
        400,
      );
    }
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
  await dbRun(
    sql,
    `UPDATE journal_entries SET ${sets.join(', ')}
       WHERE id = $${p++} AND household_id = $${p} AND deleted_at IS NULL`,
    params,
  );

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

  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'Empty body' } }, 400);
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
