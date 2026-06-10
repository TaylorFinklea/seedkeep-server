import { Hono } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { dbAll, dbBatch, dbGet, dbRun, isFkViolation, isUniqueViolation } from '../db/helpers';
import { getSql } from '../db/client';
import { buildDeltaPayload, parseDeltaQuery } from '../lib/sync';
import type { Sql } from 'postgres';

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
  tag_ids: z.array(z.string()).max(50).optional(),
});

const updateSchema = createSchema.partial();

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
    {
      sql: `UPDATE seeds SET updated_at = $1 WHERE id = $2 AND household_id = $3`,
      params: [now, seedId, householdId],
    },
  ];
}

async function setSeedTags(
  sql: Sql,
  seedId: string,
  householdId: string,
  tagIds: string[],
  now: number,
): Promise<void> {
  await dbBatch(sql, seedTagStatements(seedId, householdId, tagIds, now));
}

// SQL fragment: aggregates a seed's tag_ids into a Postgres TEXT[] (native
// array). NULL when no tags — `COALESCE` to an empty array. Returns the
// column as `tag_ids` in the result set.
const TAG_IDS_AGG = `COALESCE(
  (SELECT array_agg(tag_id ORDER BY tag_id) FROM seed_tags WHERE seed_id = s.id),
  ARRAY[]::TEXT[]
) AS tag_ids`;

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
  addWhere('s.updated_at > ?', query.since);

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
      'EXISTS (SELECT 1 FROM seed_tags st WHERE st.seed_id = s.id AND st.tag_id = ?)',
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
            s.custom_variety, s.custom_company, s.notes,
            s.created_at, s.updated_at, s.deleted_at,
            ${TAG_IDS_AGG}
       FROM seeds s
      WHERE ${wheres.join(' AND ')}
      ORDER BY s.updated_at ASC
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
            s.custom_variety, s.custom_company, s.notes,
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
  try {
    // Seed INSERT + tag attachment run in ONE transaction. If a tag FK
    // fails, the seed insert rolls back too — so the 'invalid_reference'
    // retry advice below is actually safe to follow (the retry won't hit
    // a duplicate-id violation from a half-committed first attempt).
    await dbBatch(sql, [
      {
        sql: `INSERT INTO seeds (
           id, household_id, catalog_id, state, packet_count,
           location_id, year_packed, source, custom_name,
           custom_variety, custom_company, notes,
           created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        params: [
          id, householdId, data.catalog_id ?? null, data.state, data.packet_count,
          data.location_id ?? null, data.year_packed ?? null, data.source,
          data.custom_name ?? null, data.custom_variety ?? null,
          data.custom_company ?? null, data.notes ?? null,
          now, now,
        ],
      },
      ...(data.tag_ids && data.tag_ids.length > 0
        ? seedTagStatements(id, householdId, data.tag_ids, now)
        : []),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Retry of a create that already committed (response lost on the
      // wire). Replay the existing row as a success when it belongs to
      // this household — same response shape as a fresh create.
      const existing = await dbGet<SeedListRow>(
        sql,
        `SELECT s.id, s.household_id, s.catalog_id, s.state, s.packet_count,
                s.location_id, s.year_packed, s.source, s.custom_name,
                s.custom_variety, s.custom_company, s.notes,
                s.created_at, s.updated_at, s.deleted_at,
                ${TAG_IDS_AGG}
           FROM seeds s
          WHERE s.id = $1 AND s.household_id = $2
          LIMIT 1`,
        [id, householdId],
      );
      if (existing) {
        const { tag_ids, ...rest } = existing;
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
        notes: data.notes ?? null,
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

  const existing = await dbGet<SeedRow>(
    sql,
    `SELECT id, household_id, catalog_id, state, packet_count, location_id,
            year_packed, source, custom_name, custom_variety, custom_company,
            notes, created_at, updated_at, deleted_at
       FROM seeds WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [id, householdId],
  );
  if (!existing) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Seed not found' } }, 404);
  }

  const data = parsed.data;
  const merged: SeedRow = {
    ...existing,
    catalog_id: data.catalog_id !== undefined ? data.catalog_id ?? null : existing.catalog_id,
    state: data.state ?? existing.state,
    packet_count: data.packet_count ?? existing.packet_count,
    location_id: data.location_id !== undefined ? data.location_id ?? null : existing.location_id,
    year_packed: data.year_packed !== undefined ? data.year_packed ?? null : existing.year_packed,
    source: data.source ?? existing.source,
    custom_name: data.custom_name !== undefined ? data.custom_name ?? null : existing.custom_name,
    custom_variety: data.custom_variety !== undefined ? data.custom_variety ?? null : existing.custom_variety,
    custom_company: data.custom_company !== undefined ? data.custom_company ?? null : existing.custom_company,
    notes: data.notes !== undefined ? data.notes ?? null : existing.notes,
    updated_at: Date.now(),
  };

  try {
    await dbRun(
      sql,
      `UPDATE seeds SET
         catalog_id = $1, state = $2, packet_count = $3, location_id = $4,
         year_packed = $5, source = $6, custom_name = $7, custom_variety = $8,
         custom_company = $9, notes = $10, updated_at = $11
       WHERE id = $12 AND household_id = $13`,
      [
        merged.catalog_id, merged.state, merged.packet_count, merged.location_id,
        merged.year_packed, merged.source, merged.custom_name, merged.custom_variety,
        merged.custom_company, merged.notes, merged.updated_at,
        id, householdId,
      ],
    );

    if (data.tag_ids !== undefined) {
      await setSeedTags(sql, id, householdId, data.tag_ids, merged.updated_at);
    }
  } catch (err) {
    if (isFkViolation(err)) {
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

  // Re-read tag_ids to return the current set.
  const tagRow = await dbGet<{ tag_ids: string[] | null }>(
    sql,
    `SELECT COALESCE(
              (SELECT array_agg(tag_id ORDER BY tag_id) FROM seed_tags WHERE seed_id = $1),
              ARRAY[]::TEXT[]
            ) AS tag_ids`,
    [id],
  );
  return c.json({
    ok: true,
    data: {
      seed: { ...merged, tag_ids: tagRow?.tag_ids ?? [] },
    },
  });
});

seedRoutes.delete('/seeds/:id', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const id = c.req.param('id');
  const sql = getSql(c.env);
  const now = Date.now();
  const result = await dbRun(
    sql,
    `UPDATE seeds SET deleted_at = $1, updated_at = $2
       WHERE id = $3 AND household_id = $4 AND deleted_at IS NULL`,
    [now, now, id, householdId],
  );
  if (result.meta.changes === 0) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Seed not found' } }, 404);
  }
  // Cascade soft-delete to children so iOS sees matching tombstones on
  // the next pull. Without this, planting_events + journal_entries
  // keep referencing the (now-deleted) seed forever.
  await dbRun(sql,
    `UPDATE planting_events SET deleted_at = $1, updated_at = $1
       WHERE seed_id = $2 AND household_id = $3 AND deleted_at IS NULL`,
    [now, id, householdId]);
  await dbRun(sql,
    `UPDATE journal_entries SET deleted_at = $1, updated_at = $1
       WHERE seed_id = $2 AND household_id = $3 AND deleted_at IS NULL`,
    [now, id, householdId]);
  return c.json({ ok: true, data: { id, deleted_at: now } });
});
