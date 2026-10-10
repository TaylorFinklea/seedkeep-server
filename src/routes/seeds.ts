import { Hono } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { dbAll, dbGet, dbRun, isFkViolation, isUniqueViolation, type Queryable } from '../db/helpers';
import { getSql } from '../db/client';
import { buildDeltaPayload, parseDeltaQuery } from '../lib/sync';
import { deletePhoto } from '../lib/storage';
import { expectedVersion, invalidIfMatch, setVersionHeader, versionConflict } from '../lib/versioning';

export const seedRoutes = new Hono<AppEnv>();

const auth = [requireAuth(), requireHousehold()] as const;

const STATES = ['active', 'wishlist', 'saved', 'archived'] as const;
const SOURCES = ['store', 'saved', 'gift', 'swap'] as const;

interface SeedRow {
  id: string;
  household_id: string;
  catalog_id: string | null;
  state: typeof STATES[number];
  packet_count: number;
  location_id: string | null;
  year_packed: number | null;
  source: typeof SOURCES[number];
  custom_name: string | null;
  custom_variety: string | null;
  custom_company: string | null;
  notes: string | null;
  custom_type: string | null;
  version: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface SeedListRow extends SeedRow {
  // Postgres `array_agg` returns the column as a native JS array
  // (postgres.js handles the conversion), unlike SQLite's
  // `json_group_array` which returns a JSON string.
  tag_ids: string[] | null;
}

interface SeedPhotoRow {
  id: string;
  seed_id: string;
  household_id: string;
  r2_key: string;
  role: 'front' | 'back' | 'extra';
  width: number | null;
  height: number | null;
  byte_size: number | null;
  captured_at: number;
}

const createSchema = z.object({
  // Optional client-supplied ID lets the iOS client create rows offline
  // and push later without needing the server to round-trip an ID first.
  // The iOS app generates ids like `seed_local_<36-char-uuid>` (47 chars),
  // so the cap is 80 to match the other tables' id columns + leave room
  // for any future prefix changes.
  id: z.string().min(1).max(80).optional(),
  catalog_id: z.string().nullish(),
  state: z.enum(STATES),
  packet_count: z.number().int().min(0).max(10_000).default(1),
  location_id: z.string().nullish(),
  year_packed: z.number().int().min(1900).max(2200).nullish(),
  source: z.enum(SOURCES).default('store'),
  custom_name: z.string().trim().max(120).nullish(),
  custom_variety: z.string().trim().max(120).nullish(),
  custom_company: z.string().trim().max(120).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  custom_type: z.string().trim().max(80).nullish(),
  tag_ids: z.array(z.string()).max(50).refine((ids) => new Set(ids).size === ids.length, 'tag_ids must be unique').optional(),
});

// Defaults belong to creates. PATCH must leave omitted defaulted fields alone.
const updateSchema = createSchema.extend({
  packet_count: z.number().int().min(0).max(10_000).optional(),
  source: z.enum(SOURCES).optional(),
}).partial();

const listFiltersSchema = z.object({
  state: z.enum(STATES).optional(),
  location_id: z.string().optional(),
  tag_id: z.string().optional(),
});

function seedTagStatements(
  seedId: string,
  householdId: string,
  tagIds: string[],
  now: number,
  bumpParent = true,
): { sql: string; params: unknown[] }[] {
  return [
    {
      sql: `DELETE FROM seed_tags WHERE seed_id = $1 AND household_id = $2`,
      params: [seedId, householdId],
    },
    ...tagIds.map((tagId) => ({
      sql: `INSERT INTO seed_tags (seed_id, tag_id, household_id) VALUES ($1, $2, $3)`,
      params: [seedId, tagId, householdId] as unknown[],
    })),
    ...(bumpParent ? [{
      sql: `UPDATE seeds SET updated_at = $1, version = version + 1 WHERE id = $2 AND household_id = $3`,
      params: [now, seedId, householdId],
    }] : []),
  ];
}

// SQL fragment: aggregates a seed's tag_ids into a Postgres TEXT[] (native
// array). NULL when no tags — `COALESCE` to an empty array. Returns the
// column as `tag_ids` in the result set.
const TAG_IDS_AGG = `COALESCE(
  (SELECT array_agg(tag_id ORDER BY tag_id) FROM seed_tags WHERE seed_id = s.id AND household_id = s.household_id),
  ARRAY[]::TEXT[]
) AS tag_ids`;

async function lockSeedReferences(
  q: Queryable,
  householdId: string,
  locationId: string | null | undefined,
  tagIds: string[] | undefined,
): Promise<boolean> {
  if (locationId) {
    const row = await dbGet<{ id: string }>(q,
      `SELECT id FROM locations WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR SHARE`,
      [locationId, householdId]);
    if (!row) return false;
  }
  if (tagIds?.length) {
    const rows = await dbAll<{ id: string }>(q,
      `SELECT id FROM tags WHERE id = ANY($1) AND household_id = $2 AND deleted_at IS NULL ORDER BY id FOR SHARE`,
      [tagIds, householdId]);
    if (new Set(rows.map((r) => r.id)).size !== new Set(tagIds).size) return false;
  }
  return true;
}

/**
 * GET /api/seeds?since=<ms>&limit=<n>&state=<>&location_id=<>&tag_id=<>
 *
 * Delta-sync friendly listing. When `since=0`, soft-deletes are hidden;
 * any non-zero `since` includes deletes so clients can purge.
 */
seedRoutes.get('/seeds', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const sql = getSql(c.env);
  const url = new URL(c.req.url);
  const query = parseDeltaQuery(url.searchParams);
  const filters = listFiltersSchema.safeParse({
    state: url.searchParams.get('state') ?? undefined,
    location_id: url.searchParams.get('location_id') ?? undefined,
    tag_id: url.searchParams.get('tag_id') ?? undefined,
  });
  if (!filters.success) {
    return c.json({ ok: false, error: { code: 'bad_request', message: filters.error.message } }, 400);
  }

  // Build the WHERE clauses with positional params. We track the count so
  // each `?` becomes the next `$N`.
  const wheres: string[] = [];
  const params: unknown[] = [];
  const addWhere = (clause: string, ...args: unknown[]) => {
    let i = params.length;
    const replaced = clause.replace(/\?/g, () => `$${++i}`);
    wheres.push(replaced);
    params.push(...args);
  };

  addWhere('s.household_id = ?', householdId);
  if (query.sinceId !== null) {
    // Composite cursor (contract decision 9): resume mid-millisecond via
    // the id tiebreaker so tied rows straddling a page boundary aren't
    // skipped forever.
    addWhere(
      '(s.updated_at > ? OR (s.updated_at = ? AND s.id > ?))',
      query.since, query.since, query.sinceId,
    );
  } else {
    addWhere('s.updated_at > ?', query.since);
  }

  if (query.since === 0) {
    wheres.push(`s.deleted_at IS NULL`);
  }
  if (filters.data.state) {
    addWhere('s.state = ?', filters.data.state);
  }
  if (filters.data.location_id) {
    addWhere('s.location_id = ?', filters.data.location_id);
  }
  if (filters.data.tag_id) {
    addWhere(
      'EXISTS (SELECT 1 FROM seed_tags st WHERE st.seed_id = s.id AND st.household_id = s.household_id AND st.tag_id = ?)',
      filters.data.tag_id,
    );
  }
  // LIMIT param is the next placeholder.
  const limitPlaceholder = `$${params.length + 1}`;
  params.push(query.limit);

  const items = await dbAll<SeedListRow>(
    sql,
    `SELECT s.id, s.household_id, s.catalog_id, s.state, s.packet_count,
            s.location_id, s.year_packed, s.source, s.custom_name,
            s.custom_variety, s.custom_company, s.custom_type, s.notes, s.version,
            s.created_at, s.updated_at, s.deleted_at,
            ${TAG_IDS_AGG}
       FROM seeds s
      WHERE ${wheres.join(' AND ')}
      ORDER BY s.updated_at ASC, s.id ASC
      LIMIT ${limitPlaceholder}`,
    params,
  );

  const shaped = items.map(({ tag_ids, ...rest }) => ({
    ...rest,
    tag_ids: tag_ids ?? [],
  }));
  return c.json({ ok: true, data: buildDeltaPayload(shaped, query) });
});

/**
 * GET /api/seeds/:id — full detail with tag_ids and photo metadata.
 */
seedRoutes.get('/seeds/:id', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const id = c.req.param('id');
  const sql = getSql(c.env);
  const seed = await dbGet<SeedListRow>(
    sql,
    `SELECT s.id, s.household_id, s.catalog_id, s.state, s.packet_count,
            s.location_id, s.year_packed, s.source, s.custom_name,
            s.custom_variety, s.custom_company, s.custom_type, s.notes, s.version,
            s.created_at, s.updated_at, s.deleted_at,
            ${TAG_IDS_AGG}
       FROM seeds s
      WHERE s.id = $1 AND s.household_id = $2 AND s.deleted_at IS NULL
      LIMIT 1`,
    [id, householdId],
  );
  if (!seed) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Seed not found' } }, 404);
  }
  setVersionHeader(c, seed.version);
  const photos = await dbAll<SeedPhotoRow>(
    sql,
    `SELECT id, seed_id, household_id, r2_key, role, width, height, byte_size, captured_at
       FROM seed_photos WHERE seed_id = $1 AND household_id = $2 ORDER BY captured_at ASC`,
    [id, householdId],
  );
  const { tag_ids, ...rest } = seed;
  return c.json({
    ok: true,
    data: {
      seed: { ...rest, tag_ids: tag_ids ?? [] },
      photos,
    },
  });
});

/**
 * POST /api/seeds — create. Accepts an optional client-supplied id for
 * offline-first sync from the iOS client.
 */
seedRoutes.post('/seeds', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const sql = getSql(c.env);
  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: { code: 'bad_request', message: parsed.error.message } }, 400);
  }
  const id = parsed.data.id ?? nanoid();
  const now = Date.now();
  const data = parsed.data;
  if (parsed.data.id) {
    const existing = await dbGet<SeedListRow>(sql,
      `SELECT s.id, s.household_id, s.catalog_id, s.state, s.packet_count, s.location_id, s.year_packed,
              s.source, s.custom_name, s.custom_variety, s.custom_company, s.custom_type, s.notes,
              s.created_at, s.updated_at, s.deleted_at, s.version, ${TAG_IDS_AGG}
         FROM seeds s WHERE s.id = $1 AND s.household_id = $2 LIMIT 1`, [id, householdId]);
    if (existing) {
      const { tag_ids, ...rest } = existing;
      setVersionHeader(c, existing.version);
      return c.json({ ok: true, data: { seed: { ...rest, tag_ids: tag_ids ?? [] } } });
    }
    if (await dbGet(sql, `SELECT id FROM seeds WHERE id = $1`, [id])) return c.json({ ok: false, error: { code: 'conflict', message: 'A record with this id already exists.' } }, 409);
  }
  try {
    // Seed INSERT + tag attachment run in ONE transaction. If a tag FK
    // fails, the seed insert rolls back too — so the 'invalid_reference'
    // retry advice below is actually safe to follow (the retry won't hit
    // a duplicate-id violation from a half-committed first attempt).
    await sql.begin(async (tx) => {
      if (!await lockSeedReferences(tx, householdId, data.location_id ?? null, data.tag_ids)) {
        const error = new Error('invalid_reference');
        (error as Error & { code?: string }).code = 'SEED_INVALID_REFERENCE';
        throw error;
      }
      const statements = [
      {
        sql: `INSERT INTO seeds (
           id, household_id, catalog_id, state, packet_count,
           location_id, year_packed, source, custom_name,
           custom_variety, custom_company, custom_type, notes,
           created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        params: [
          id, householdId, data.catalog_id ?? null, data.state, data.packet_count,
          data.location_id ?? null, data.year_packed ?? null, data.source,
          data.custom_name ?? null, data.custom_variety ?? null,
          data.custom_company ?? null, data.custom_type ?? null, data.notes ?? null,
          now, now,
        ],
      },
      ...(data.tag_ids && data.tag_ids.length > 0
        ? seedTagStatements(id, householdId, data.tag_ids, now, false)
        : []),
      ];
      for (const stmt of statements) await dbRun(tx, stmt.sql, stmt.params);
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'invalid_reference') {
      return c.json({ ok: false, error: { code: 'invalid_reference', message: 'A referenced location or tag does not exist in this household.' } }, 400);
    }
    if (isUniqueViolation(err)) {
      // Retry of a create that already committed (response lost on the
      // wire). Replay the existing row as a success when it belongs to
      // this household — same response shape as a fresh create.
      const existing = await dbGet<SeedListRow>(
        sql,
        `SELECT s.id, s.household_id, s.catalog_id, s.state, s.packet_count,
                s.location_id, s.year_packed, s.source, s.custom_name,
                s.custom_variety, s.custom_company, s.custom_type, s.notes, s.version,
                s.created_at, s.updated_at, s.deleted_at,
                ${TAG_IDS_AGG}
           FROM seeds s
          WHERE s.id = $1 AND s.household_id = $2
          LIMIT 1`,
        [id, householdId],
      );
      if (existing) {
        const { tag_ids, ...rest } = existing;
        setVersionHeader(c, existing.version);
        return c.json({ ok: true, data: { seed: { ...rest, tag_ids: tag_ids ?? [] } } });
      }
      return c.json({
        ok: false,
        error: { code: 'conflict', message: 'A record with this id already exists.' },
      }, 409);
    }
    if (isFkViolation(err)) {
      return c.json({
        ok: false,
        error: {
          code: 'invalid_reference',
          message:
            'A referenced catalog, location, or tag does not exist on the server. Sync the parent records first (Settings → Sync → Pending writes → Retry), then retry this seed.',
        },
      }, 400);
    }
    throw err;
  }
  setVersionHeader(c, 1);
  return c.json({
    ok: true,
    data: {
      seed: {
        id,
        household_id: householdId,
        catalog_id: data.catalog_id ?? null,
        state: data.state,
        packet_count: data.packet_count,
        location_id: data.location_id ?? null,
        year_packed: data.year_packed ?? null,
        source: data.source,
        custom_name: data.custom_name ?? null,
        custom_variety: data.custom_variety ?? null,
        custom_company: data.custom_company ?? null,
        custom_type: data.custom_type ?? null,
        notes: data.notes ?? null,
        version: 1,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        tag_ids: data.tag_ids ?? [],
      },
    },
  });
});

/**
 * PATCH /api/seeds/:id — partial update. tag_ids replaces the whole set
 * (omit to leave tags untouched).
 */
seedRoutes.patch('/seeds/:id', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const id = c.req.param('id');
  const sql = getSql(c.env);
  const body = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: { code: 'bad_request', message: parsed.error.message } }, 400);
  }

  const data = parsed.data;
  const expected = expectedVersion(c);
  if (expected === 'invalid') return invalidIfMatch(c);
  const now = Date.now();
  const columns: Record<string, unknown> = {};
  for (const key of [
    'catalog_id', 'state', 'packet_count', 'location_id', 'year_packed', 'source',
    'custom_name', 'custom_variety', 'custom_company', 'custom_type', 'notes',
  ] as const) {
    if (data[key] !== undefined) columns[key] = data[key] ?? null;
  }
  const names = Object.keys(columns);
  const setSql = names.map((name, i) => `${name} = $${i + 1}`).concat(
    [`updated_at = $${names.length + 1}`, `version = version + 1`],
  ).join(', ');
  const params = [...names.map((name) => columns[name]), now, id, householdId];
  let where = `id = $${names.length + 2} AND household_id = $${names.length + 3} AND deleted_at IS NULL`;
  if (expected !== null) {
    params.push(expected);
    where += ` AND version = $${params.length}`;
  }
  let result: { row: SeedListRow | null; current: SeedListRow | null };
  try {
    result = await sql.begin(async (tx) => {
      const desiredLocation = data.location_id !== undefined ? data.location_id ?? null : null;
      if (desiredLocation && !await lockSeedReferences(tx, householdId, desiredLocation, undefined)) {
        throw Object.assign(new Error('invalid_reference'), { code: 'SEED_INVALID_REFERENCE' });
      }
      if (data.tag_ids !== undefined && !await lockSeedReferences(tx, householdId, null, data.tag_ids)) {
        throw Object.assign(new Error('invalid_reference'), { code: 'SEED_INVALID_REFERENCE' });
      }
      const owner = await dbGet<SeedRow>(tx,
        `SELECT id, household_id, catalog_id, state, packet_count, location_id, year_packed,
                source, custom_name, custom_variety, custom_company, custom_type, notes,
                created_at, updated_at, deleted_at, version
           FROM seeds WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [id, householdId]);
      if (!owner) return { row: null, current: null };
      const updated = await tx.unsafe<{ id: string }[]>(
        `UPDATE seeds SET ${setSql} WHERE ${where} RETURNING *`,
        params as never,
      );
      const selectCurrent = async () => dbGet<SeedListRow>(tx,
        `SELECT s.id, s.household_id, s.catalog_id, s.state, s.packet_count, s.location_id,
                s.year_packed, s.source, s.custom_name, s.custom_variety, s.custom_company,
                s.custom_type, s.notes, s.created_at, s.updated_at, s.deleted_at, s.version,
                ${TAG_IDS_AGG} FROM seeds s
          WHERE s.id = $1 AND s.household_id = $2 AND s.deleted_at IS NULL`, [id, householdId]);
      if (!updated[0]) {
        const current = await selectCurrent();
        return { row: null, current };
      }
      if (data.tag_ids !== undefined) {
        await dbRun(tx, `DELETE FROM seed_tags WHERE seed_id = $1 AND household_id = $2`, [id, householdId]);
        for (const tagId of data.tag_ids) {
          await dbRun(tx, `INSERT INTO seed_tags (seed_id, tag_id, household_id) VALUES ($1, $2, $3)`, [id, tagId, householdId]);
        }
      }
      const row = await selectCurrent();
      return { row, current: null };
    });
  } catch (err) {
    if (isFkViolation(err) || (err instanceof Error && err.message === 'invalid_reference')) {
      return c.json({
        ok: false,
        error: {
          code: 'invalid_reference',
          message:
            'A referenced catalog, location, or tag does not exist on the server. Sync the parent records first, then retry this update.',
        },
      }, 400);
    }
    throw err;
  }
  if (!result!.row) {
    if (!result!.current) return c.json({ ok: false, error: { code: 'not_found', message: 'Seed not found' } }, 404);
    const { tag_ids, ...current } = result!.current;
    if (expected !== null) return versionConflict(c, { ...current, tag_ids: tag_ids ?? [] });
    return c.json({ ok: false, error: { code: 'not_found', message: 'Seed not found' } }, 404);
  }
  const { tag_ids, ...row } = result!.row;
  setVersionHeader(c, row.version);
  return c.json({
    ok: true,
    data: { seed: { ...row, tag_ids: tag_ids ?? [] } },
  });
});

seedRoutes.delete('/seeds/:id', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const id = c.req.param('id');
  const sql = getSql(c.env);
  const expected = expectedVersion(c);
  if (expected === 'invalid') return invalidIfMatch(c);
  const now = Date.now();
  const result = await sql.begin(async (tx) => {
    const current = await dbGet<SeedListRow>(tx,
      `SELECT s.id, s.household_id, s.catalog_id, s.state, s.packet_count, s.location_id, s.year_packed,
              s.source, s.custom_name, s.custom_variety, s.custom_company, s.custom_type, s.notes,
              s.created_at, s.updated_at, s.deleted_at, s.version, ${TAG_IDS_AGG}
         FROM seeds s WHERE s.id = $1 AND s.household_id = $2 AND s.deleted_at IS NULL FOR UPDATE`, [id, householdId]);
    if (!current) return { gone: true as const, current: null, keys: [] as string[] };
    const params = expected === null ? [now, id, householdId] : [now, id, householdId, expected];
    const changed = await tx.unsafe<{ version: number }[]>(
      `UPDATE seeds SET deleted_at = $1, updated_at = $1, version = version + 1
        WHERE id = $2 AND household_id = $3 AND deleted_at IS NULL${expected === null ? '' : ' AND version = $4'} RETURNING version`, params as never);
    if (!changed[0]) return { gone: false as const, current, keys: [] as string[] };
    const events = await tx.unsafe<{ id: string }[]>(
      `SELECT id FROM planting_events WHERE seed_id = $1 AND household_id = $2 AND deleted_at IS NULL ORDER BY id FOR UPDATE`, [id, householdId]);
    const eventIds = events.map((e) => e.id);
    const entries = await tx.unsafe<{ id: string }[]>(
      `SELECT id FROM journal_entries WHERE household_id = $1 AND deleted_at IS NULL AND (seed_id = $2 OR planting_event_id = ANY($3)) ORDER BY id FOR UPDATE`, [householdId, id, eventIds]);
    await tx.unsafe<{ id: string }[]>(
      `UPDATE planting_events SET deleted_at = $1, updated_at = $1, version = version + 1
        WHERE seed_id = $2 AND household_id = $3 AND deleted_at IS NULL RETURNING id`, [now, id, householdId]);
    await tx.unsafe(
      `UPDATE journal_entries SET deleted_at = $1, updated_at = $1, version = version + 1
        WHERE id = ANY($2) AND household_id = $3 AND deleted_at IS NULL`,
      [now, entries.map((e) => e.id), householdId]);
    const journalPhotos = await tx.unsafe<{ storage_key: string }[]>(
      `SELECT p.storage_key FROM journal_entry_photos p JOIN journal_entries j ON j.id = p.entry_id
        WHERE j.household_id = $1 AND (j.seed_id = $2 OR j.planting_event_id = ANY($3))`, [householdId, id, eventIds]);
    await tx.unsafe(`DELETE FROM journal_entry_photos p USING journal_entries j
      WHERE p.entry_id = j.id AND j.household_id = $1 AND (j.seed_id = $2 OR j.planting_event_id = ANY($3))`, [householdId, id, eventIds]);
    await tx.unsafe(`DELETE FROM journal_checklist_items ci USING journal_entries j
      WHERE ci.entry_id = j.id AND j.household_id = $1 AND (j.seed_id = $2 OR j.planting_event_id = ANY($3))`, [householdId, id, eventIds]);
    const seedPhotos = await tx.unsafe<{ r2_key: string }[]>(
      `SELECT r2_key FROM seed_photos WHERE seed_id = $1 AND household_id = $2`, [id, householdId]);
    await tx.unsafe(`DELETE FROM seed_photos WHERE seed_id = $1 AND household_id = $2`, [id, householdId]);
    return { gone: false as const, current: null, keys: [...seedPhotos.map((p) => p.r2_key), ...journalPhotos.map((p) => p.storage_key)], version: changed[0].version };
  });
  if (result.gone) return c.json({ ok: false, error: { code: 'not_found', message: 'Seed not found' } }, 404);
  if (result.current) {
    if (expected !== null) return versionConflict(c, { ...result.current, tag_ids: result.current.tag_ids ?? [] });
    return c.json({ ok: false, error: { code: 'not_found', message: 'Seed not found' } }, 404);
  }
  await Promise.allSettled(result.keys.map((key) => deletePhoto(c.env, key)));
  setVersionHeader(c, result.version!);
  return c.json({ ok: true, data: { id, deleted_at: now, version: result.version } });
});
