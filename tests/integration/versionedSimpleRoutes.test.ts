/**
 * Web M1 Phase 3 · integration tests for versioned writes on locations,
 * tags and beds.
 *
 * Contract under test (.docs/ai/plans/web-m1-p3-integrity.md):
 *   - Every row carries a numeric `version`; new rows start at 1; every
 *     write bumps it by one. Responses that carry a row set `ETag`.
 *   - PATCH is field-selective and conditional on If-Match. A stale version
 *     is 409 `version_conflict` with `data.current`; a missing or deleted
 *     row is 404. A malformed If-Match is 400. No If-Match still works.
 *   - DELETE is one transaction. The bed cascade tombstones planting events,
 *     their journal entries and the journal entries attached to the bed,
 *     then hard-deletes those entries' checklist items. Location and tag
 *     deletes bump the seeds they touch.
 *   - Client-id create replays within a household; another household's id
 *     is a 409 `conflict` and reveals nothing.
 *
 * Mirrors `seedCreateIdempotency.test.ts`: local Postgres, a minimal
 * user → session → household → membership chain, requests driven through
 * the Hono app. Run with:
 *
 *   bun test tests/integration/versionedSimpleRoutes.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import postgres, { type Sql } from 'postgres';
import { createApp } from '../../src/index';
import type { Env } from '../../src/env';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://seedkeep:dev-only@localhost:5432/seedkeep';

const sql: Sql = postgres(DATABASE_URL, {
  transform: { undefined: null },
  onnotice: () => { /* silence */ },
  types: {
    bigint: {
      to: 20,
      from: [20],
      serialize: (x: number | bigint) => String(x),
      parse: (x: string) => Number(x),
    },
  },
});

const TEST_ENV: Env = {
  PORT: 8787,
  APP_ENV: 'development',
  DATABASE_URL,
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
  S3_BUCKET: 'test-bucket',
  S3_FORCE_PATH_STYLE: false,
  BETTER_AUTH_SECRET: 'test-better-auth-secret-1234567890',
  APPLE_CLIENT_ID: 'test-apple-client',
  APPLE_CLIENT_SECRET: 'test-apple-secret',
  ANTHROPIC_API_KEY: undefined,
  APPLE_IAP_SHARED_SECRET: undefined,
  ASSISTANT_KEY_MASTER: undefined,
  DEFAULT_VISION_MODEL: 'claude-sonnet-4-6',
  DEFAULT_REVIEW_MODEL: 'claude-haiku-4-5-20251001',
  ADMIN_SECRET: undefined,
  GARDEN_TOOLS_ENABLED: true,
};

const cleanup = {
  userIds: new Set<string>(),
  householdIds: new Set<string>(),
};

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 12)}`;
}

interface Fixture {
  userId: string;
  householdId: string;
  sessionToken: string;
}

async function seedAuthFixture(): Promise<Fixture> {
  const userId = uid('vs-user');
  const householdId = uid('vs-hh');
  const sessionId = uid('vs-sess');
  const sessionToken = uid('vs-tok');
  const now = Date.now();

  await sql.unsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'Test User', $2, TRUE, $3, $3)`,
    [userId, `${userId}@example.invalid`, now],
  );
  cleanup.userIds.add(userId);

  await sql.unsafe(
    `INSERT INTO session (id, "expiresAt", token, "createdAt", "updatedAt",
                          "ipAddress", "userAgent", "userId")
     VALUES ($1, NOW() + INTERVAL '1 day', $2, NOW(), NOW(), NULL, NULL, $3)`,
    [sessionId, sessionToken, userId],
  );

  await sql.unsafe(
    `INSERT INTO households (id, name, created_at, updated_at)
     VALUES ($1, 'Test Household', $2, $2)`,
    [householdId, now],
  );
  cleanup.householdIds.add(householdId);

  await sql.unsafe(
    `INSERT INTO memberships (household_id, user_id, role, joined_at)
     VALUES ($1, $2, 'owner', $3)`,
    [householdId, userId, now],
  );

  return { userId, householdId, sessionToken };
}

interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; message: string };
}

interface Call {
  status: number;
  json: Envelope;
  etag: string | null;
}

async function call(
  app: ReturnType<typeof createApp>,
  fx: Fixture,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  opts: { body?: unknown; ifMatch?: string } = {},
): Promise<Call> {
  const headers: Record<string, string> = { Authorization: `Bearer ${fx.sessionToken}` };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.ifMatch !== undefined) headers['If-Match'] = opts.ifMatch;
  const res = await app.request(
    path,
    {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    },
    TEST_ENV,
  );
  return {
    status: res.status,
    json: (await res.json()) as Envelope,
    etag: res.headers.get('ETag'),
  };
}

async function insertSeed(
  householdId: string,
  id: string,
  locationId: string | null,
): Promise<void> {
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO seeds (id, household_id, state, location_id, created_at, updated_at)
     VALUES ($1, $2, 'active', $3, $4, $4)`,
    [id, householdId, locationId, now],
  );
}

async function rowVersion(table: string, id: string): Promise<number> {
  const rows = await sql.unsafe<{ version: number }[]>(
    `SELECT version FROM ${table} WHERE id = $1`,
    [id],
  );
  return rows[0]!.version;
}

beforeAll(async () => {
  await sql`SELECT 1`;
});

afterAll(async () => {
  for (const id of cleanup.householdIds) {
    await sql.unsafe(`DELETE FROM households WHERE id = $1`, [id]).catch(() => {});
  }
  for (const id of cleanup.userIds) {
    await sql.unsafe(`DELETE FROM "user" WHERE id = $1`, [id]).catch(() => {});
  }
  await sql.end({ timeout: 5 });
});

describe('locations — versions, If-Match and deletes', () => {
  it('new rows start at version 1 with an ETag; each PATCH bumps the version', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const created = await call(app, fx, 'POST', '/api/locations', { body: { name: 'Shed' } });
    expect(created.status).toBe(200);
    const loc = created.json.data.location;
    expect(loc.version).toBe(1);
    expect(created.etag).toBe('"1"');

    const first = await call(app, fx, 'PATCH', `/api/locations/${loc.id}`, { body: { name: 'Barn' } });
    expect(first.status).toBe(200);
    expect(first.json.data.location.version).toBe(2);
    expect(first.etag).toBe('"2"');

    const second = await call(app, fx, 'PATCH', `/api/locations/${loc.id}`, { body: { sort_order: 3 } });
    expect(second.json.data.location.version).toBe(3);
    expect(await rowVersion('locations', loc.id)).toBe(3);
  });

  it('If-Match: a match succeeds, a mismatch is 409 with data.current, a malformed value is 400', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const loc = (await call(app, fx, 'POST', '/api/locations', { body: { name: 'Shed' } })).json.data.location;

    const ok = await call(app, fx, 'PATCH', `/api/locations/${loc.id}`, {
      body: { name: 'Shed 2' },
      ifMatch: '"1"',
    });
    expect(ok.status).toBe(200);
    expect(ok.json.data.location.version).toBe(2);

    const stale = await call(app, fx, 'PATCH', `/api/locations/${loc.id}`, {
      body: { name: 'Stale' },
      ifMatch: '"1"',
    });
    expect(stale.status).toBe(409);
    expect(stale.json.ok).toBe(false);
    expect(stale.json.error!.code).toBe('version_conflict');
    expect(stale.json.data!.current.name).toBe('Shed 2');
    expect(stale.json.data!.current.version).toBe(2);

    for (const bad of ['abc', 'W/"2"', '0', '"2']) {
      const res = await call(app, fx, 'PATCH', `/api/locations/${loc.id}`, {
        body: { name: 'X' },
        ifMatch: bad,
      });
      expect(res.status).toBe(400);
    }
    expect(await rowVersion('locations', loc.id)).toBe(2);
  });

  it('no If-Match still succeeds (legacy last-write-wins)', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const loc = (await call(app, fx, 'POST', '/api/locations', { body: { name: 'Shed' } })).json.data.location;
    await call(app, fx, 'PATCH', `/api/locations/${loc.id}`, { body: { name: 'A' } });
    const legacy = await call(app, fx, 'PATCH', `/api/locations/${loc.id}`, { body: { name: 'B' } });
    expect(legacy.status).toBe(200);
    expect(legacy.json.data.location.name).toBe('B');
  });

  it('two concurrent PATCHes with the same If-Match: exactly one succeeds', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const loc = (await call(app, fx, 'POST', '/api/locations', { body: { name: 'Shed' } })).json.data.location;

    const results = await Promise.all([
      call(app, fx, 'PATCH', `/api/locations/${loc.id}`, { body: { name: 'One' }, ifMatch: '"1"' }),
      call(app, fx, 'PATCH', `/api/locations/${loc.id}`, { body: { name: 'Two' }, ifMatch: '"1"' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await rowVersion('locations', loc.id)).toBe(2);
  });

  it('field-selective: a PATCH of sort_order does not clobber an earlier name change', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const loc = (await call(app, fx, 'POST', '/api/locations', { body: { name: 'Shed' } })).json.data.location;
    await call(app, fx, 'PATCH', `/api/locations/${loc.id}`, { body: { name: 'Greenhouse' } });
    const res = await call(app, fx, 'PATCH', `/api/locations/${loc.id}`, { body: { sort_order: 5 } });
    expect(res.json.data.location.name).toBe('Greenhouse');
    expect(res.json.data.location.sort_order).toBe(5);
  });

  it('delete honours If-Match, tombstones with a bump, and a repeat delete is 404', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const loc = (await call(app, fx, 'POST', '/api/locations', { body: { name: 'Shed' } })).json.data.location;
    await call(app, fx, 'PATCH', `/api/locations/${loc.id}`, { body: { name: 'Shed 2' } });

    const stale = await call(app, fx, 'DELETE', `/api/locations/${loc.id}`, { ifMatch: '"1"' });
    expect(stale.status).toBe(409);
    expect(stale.json.data!.current.version).toBe(2);

    const deleted = await call(app, fx, 'DELETE', `/api/locations/${loc.id}`, { ifMatch: '"2"' });
    expect(deleted.status).toBe(200);
    expect(await rowVersion('locations', loc.id)).toBe(3);

    const again = await call(app, fx, 'DELETE', `/api/locations/${loc.id}`);
    expect(again.status).toBe(404);

    const patchDeleted = await call(app, fx, 'PATCH', `/api/locations/${loc.id}`, {
      body: { name: 'Ghost' },
      ifMatch: '"3"',
    });
    expect(patchDeleted.status).toBe(404);
  });

  it('deleting a location clears location_id on its seeds and bumps each seed version', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const loc = (await call(app, fx, 'POST', '/api/locations', { body: { name: 'Shed' } })).json.data.location;
    const withLoc = uid('seed');
    const without = uid('seed');
    await insertSeed(fx.householdId, withLoc, loc.id);
    await insertSeed(fx.householdId, without, null);

    const res = await call(app, fx, 'DELETE', `/api/locations/${loc.id}`);
    expect(res.status).toBe(200);

    const rows = await sql.unsafe<{ id: string; location_id: string | null; version: number }[]>(
      `SELECT id, location_id, version FROM seeds WHERE id = ANY($1)`,
      [[withLoc, without]],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(withLoc)!.location_id).toBeNull();
    expect(byId.get(withLoc)!.version).toBe(2);
    expect(byId.get(without)!.version).toBe(1);
  });
});

describe('locations — client-id replay and household isolation', () => {
  it('same client id POSTed twice replays the row with its version; another household gets 409', async () => {
    const fxA = await seedAuthFixture();
    const fxB = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const id = `loc_local_${uid('rp')}`;

    const first = await call(app, fxA, 'POST', '/api/locations', { body: { id, name: 'Shed' } });
    expect(first.status).toBe(200);
    const second = await call(app, fxA, 'POST', '/api/locations', { body: { id, name: 'Shed' } });
    expect(second.status).toBe(200);
    expect(second.json.data.location.created_at).toBe(first.json.data.location.created_at);
    expect(second.json.data.location.version).toBe(1);

    const foreign = await call(app, fxB, 'POST', '/api/locations', { body: { id, name: 'Other' } });
    expect(foreign.status).toBe(409);
    expect(foreign.json.error!.code).toBe('conflict');
  });
});

describe('tags — versions, If-Match and deletes', () => {
  it('versions start at 1, bump on PATCH, and If-Match mismatch is 409 with data.current', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const tag = (await call(app, fx, 'POST', '/api/tags', { body: { name: 'Organic' } })).json.data.tag;
    expect(tag.version).toBe(1);

    const ok = await call(app, fx, 'PATCH', `/api/tags/${tag.id}`, {
      body: { color: '#00ff00' },
      ifMatch: '"1"',
    });
    expect(ok.status).toBe(200);
    expect(ok.json.data.tag.version).toBe(2);
    expect(ok.json.data.tag.color).toBe('#00ff00');

    const stale = await call(app, fx, 'PATCH', `/api/tags/${tag.id}`, {
      body: { name: 'Late' },
      ifMatch: '"1"',
    });
    expect(stale.status).toBe(409);
    expect(stale.json.data!.current.name).toBe('Organic');

    const bad = await call(app, fx, 'PATCH', `/api/tags/${tag.id}`, { body: { name: 'X' }, ifMatch: 'nope' });
    expect(bad.status).toBe(400);
  });

  it('two concurrent PATCHes with the same If-Match: exactly one succeeds', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const tag = (await call(app, fx, 'POST', '/api/tags', { body: { name: 'Organic' } })).json.data.tag;
    const results = await Promise.all([
      call(app, fx, 'PATCH', `/api/tags/${tag.id}`, { body: { name: 'A' }, ifMatch: '"1"' }),
      call(app, fx, 'PATCH', `/api/tags/${tag.id}`, { body: { name: 'B' }, ifMatch: '"1"' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('deleting a tag removes its seed_tags rows and bumps only the seeds that carried it', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const tag = (await call(app, fx, 'POST', '/api/tags', { body: { name: 'Heirloom' } })).json.data.tag;
    const tagged = uid('seed');
    const untagged = uid('seed');
    await insertSeed(fx.householdId, tagged, null);
    await insertSeed(fx.householdId, untagged, null);
    await sql.unsafe(
      `INSERT INTO seed_tags (seed_id, tag_id, household_id) VALUES ($1, $2, $3)`,
      [tagged, tag.id, fx.householdId],
    );

    const res = await call(app, fx, 'DELETE', `/api/tags/${tag.id}`, { ifMatch: '"1"' });
    expect(res.status).toBe(200);
    expect(await rowVersion('tags', tag.id)).toBe(2);

    const links = await sql.unsafe<{ n: number }[]>(
      `SELECT COUNT(*)::int AS n FROM seed_tags WHERE tag_id = $1`,
      [tag.id],
    );
    expect(links[0]!.n).toBe(0);
    expect(await rowVersion('seeds', tagged)).toBe(2);
    expect(await rowVersion('seeds', untagged)).toBe(1);
  });

  it('client-id replay returns the row; another household gets 409', async () => {
    const fxA = await seedAuthFixture();
    const fxB = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const id = `tag_local_${uid('rp')}`;
    const first = await call(app, fxA, 'POST', '/api/tags', { body: { id, name: 'Organic' } });
    const replay = await call(app, fxA, 'POST', '/api/tags', { body: { id, name: 'Organic' } });
    expect(replay.status).toBe(200);
    expect(replay.json.data.tag.created_at).toBe(first.json.data.tag.created_at);
    expect(replay.json.data.tag.version).toBe(1);

    const foreign = await call(app, fxB, 'POST', '/api/tags', { body: { id, name: 'Organic' } });
    expect(foreign.status).toBe(409);
    expect(foreign.json.error!.code).toBe('conflict');
  });
});

describe('beds — versions, If-Match and deletes', () => {
  it('versions start at 1, bump on PATCH, and an ETag is set', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const created = await call(app, fx, 'POST', '/api/beds', { body: { name: 'North', width_feet: 4 } });
    const bed = created.json.data.bed;
    expect(bed.version).toBe(1);
    expect(created.etag).toBe('"1"');

    const patched = await call(app, fx, 'PATCH', `/api/beds/${bed.id}`, {
      body: { length_feet: 8 },
      ifMatch: '"1"',
    });
    expect(patched.status).toBe(200);
    expect(patched.json.data.bed.version).toBe(2);
    expect(patched.json.data.bed.width_feet).toBe(4);
    expect(patched.json.data.bed.length_feet).toBe(8);
    expect(patched.etag).toBe('"2"');
  });

  it('If-Match: mismatch is 409 with data.current, malformed is 400, a deleted bed is 404', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const bed = (await call(app, fx, 'POST', '/api/beds', { body: { name: 'North' } })).json.data.bed;
    await call(app, fx, 'PATCH', `/api/beds/${bed.id}`, { body: { name: 'North 2' } });

    const stale = await call(app, fx, 'PATCH', `/api/beds/${bed.id}`, {
      body: { name: 'Stale' },
      ifMatch: '"1"',
    });
    expect(stale.status).toBe(409);
    expect(stale.json.data!.current.name).toBe('North 2');
    expect(stale.json.data!.current.version).toBe(2);

    const malformed = await call(app, fx, 'PATCH', `/api/beds/${bed.id}`, {
      body: { name: 'X' },
      ifMatch: 'W/"2"',
    });
    expect(malformed.status).toBe(400);

    await call(app, fx, 'DELETE', `/api/beds/${bed.id}`);
    const gone = await call(app, fx, 'PATCH', `/api/beds/${bed.id}`, {
      body: { name: 'Ghost' },
      ifMatch: '"2"',
    });
    expect(gone.status).toBe(404);
  });

  it('no If-Match still succeeds, and independent field PATCHes both persist', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const bed = (await call(app, fx, 'POST', '/api/beds', { body: { name: 'North' } })).json.data.bed;
    await call(app, fx, 'PATCH', `/api/beds/${bed.id}`, { body: { description: 'Sunny' } });
    const res = await call(app, fx, 'PATCH', `/api/beds/${bed.id}`, { body: { sort_order: 2 } });
    expect(res.status).toBe(200);
    expect(res.json.data.bed.description).toBe('Sunny');
    expect(res.json.data.bed.sort_order).toBe(2);
    expect(res.json.data.bed.version).toBe(3);
  });

  it('two concurrent PATCHes with the same If-Match: exactly one succeeds', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const bed = (await call(app, fx, 'POST', '/api/beds', { body: { name: 'North' } })).json.data.bed;
    const results = await Promise.all([
      call(app, fx, 'PATCH', `/api/beds/${bed.id}`, { body: { name: 'A' }, ifMatch: '"1"' }),
      call(app, fx, 'PATCH', `/api/beds/${bed.id}`, { body: { name: 'B' }, ifMatch: '"1"' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('bed delete cascades: events, their journal entries, bed-attached entries and checklist items', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const bed = (await call(app, fx, 'POST', '/api/beds', { body: { name: 'North' } })).json.data.bed;
    const other = (await call(app, fx, 'POST', '/api/beds', { body: { name: 'South' } })).json.data.bed;
    const now = Date.now();

    const eventId = uid('pe');
    const otherEventId = uid('pe');
    const entryViaEvent = uid('je');
    const entryOnBed = uid('je');
    const entryOnOther = uid('je');
    const checklistId = uid('ci');

    await sql.unsafe(
      `INSERT INTO planting_events (id, household_id, bed_id, kind, planned_for, created_at, updated_at)
       VALUES ($1, $2, $3, 'sowing', '2026-05-01', $4, $4),
              ($5, $2, $6, 'sowing', '2026-05-01', $4, $4)`,
      [eventId, fx.householdId, bed.id, now, otherEventId, other.id],
    );
    await sql.unsafe(
      `INSERT INTO journal_entries (id, household_id, occurred_on, body, planting_event_id, created_at, updated_at)
       VALUES ($1, $2, '2026-05-02', 'sown', $3, $4, $4)`,
      [entryViaEvent, fx.householdId, eventId, now],
    );
    await sql.unsafe(
      `INSERT INTO journal_entries (id, household_id, occurred_on, body, bed_id, created_at, updated_at)
       VALUES ($1, $2, '2026-05-02', 'weeded', $3, $4, $4),
              ($5, $2, '2026-05-02', 'elsewhere', $6, $4, $4)`,
      [entryOnBed, fx.householdId, bed.id, now, entryOnOther, other.id],
    );
    await sql.unsafe(
      `INSERT INTO journal_checklist_items (id, entry_id, text, updated_at) VALUES ($1, $2, 'water', $3)`,
      [checklistId, entryViaEvent, now],
    );

    const res = await call(app, fx, 'DELETE', `/api/beds/${bed.id}`, { ifMatch: '"1"' });
    expect(res.status).toBe(200);

    expect(await rowVersion('beds', bed.id)).toBe(2);
    expect(await rowVersion('planting_events', eventId)).toBe(2);
    expect(await rowVersion('journal_entries', entryViaEvent)).toBe(2);
    expect(await rowVersion('journal_entries', entryOnBed)).toBe(2);

    const tombstones = await sql.unsafe<{ id: string; deleted_at: number | null }[]>(
      `SELECT id, deleted_at FROM journal_entries WHERE id = ANY($1)`,
      [[entryViaEvent, entryOnBed, entryOnOther]],
    );
    const byId = new Map(tombstones.map((r) => [r.id, r]));
    expect(byId.get(entryViaEvent)!.deleted_at).not.toBeNull();
    expect(byId.get(entryOnBed)!.deleted_at).not.toBeNull();
    expect(byId.get(entryOnOther)!.deleted_at).toBeNull();

    const checklist = await sql.unsafe<{ n: number }[]>(
      `SELECT COUNT(*)::int AS n FROM journal_checklist_items WHERE id = $1`,
      [checklistId],
    );
    expect(checklist[0]!.n).toBe(0);

    // The bed's other planting event was not touched.
    expect(await rowVersion('planting_events', otherEventId)).toBe(1);
  });

  it('a stale If-Match on delete is 409 and nothing cascades', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const bed = (await call(app, fx, 'POST', '/api/beds', { body: { name: 'North' } })).json.data.bed;
    await call(app, fx, 'PATCH', `/api/beds/${bed.id}`, { body: { name: 'North 2' } });
    const eventId = uid('pe');
    await sql.unsafe(
      `INSERT INTO planting_events (id, household_id, bed_id, kind, planned_for, created_at, updated_at)
       VALUES ($1, $2, $3, 'sowing', '2026-05-01', $4, $4)`,
      [eventId, fx.householdId, bed.id, Date.now()],
    );

    const res = await call(app, fx, 'DELETE', `/api/beds/${bed.id}`, { ifMatch: '"1"' });
    expect(res.status).toBe(409);
    expect(res.json.data!.current.version).toBe(2);
    expect(await rowVersion('beds', bed.id)).toBe(2);
    expect(await rowVersion('planting_events', eventId)).toBe(1);
  });

  it('client-id replay returns the row; another household gets 409', async () => {
    const fxA = await seedAuthFixture();
    const fxB = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const id = `bed_local_${uid('rp')}`;
    const first = await call(app, fxA, 'POST', '/api/beds', { body: { id, name: 'North' } });
    const replay = await call(app, fxA, 'POST', '/api/beds', { body: { id, name: 'North' } });
    expect(replay.status).toBe(200);
    expect(replay.json.data.bed.created_at).toBe(first.json.data.bed.created_at);
    expect(replay.json.data.bed.version).toBe(1);

    const foreign = await call(app, fxB, 'POST', '/api/beds', { body: { id, name: 'North' } });
    expect(foreign.status).toBe(409);
    expect(foreign.json.error!.code).toBe('conflict');
  });
});
