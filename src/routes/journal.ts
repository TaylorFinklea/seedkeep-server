import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { getSql } from '../db/client';
import { dbGet, dbAll, dbRun } from '../db/helpers';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { validateAtMostOneAttach } from '../lib/journal/validation';

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
