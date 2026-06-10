/**
 * Stabilization B3 · integration tests for client-supplied ids on the
 * core create routes (locations, tags, beds, planting-events).
 *
 * Contract decision 7: creates accept an optional client-supplied `id`;
 * a household-matching 23505 on retry replays the existing row as a 200
 * with the fresh-create response shape. For planting events the replay
 * must NOT re-create the auto-seeded journal entry + checklist item.
 *
 * Mirrors the scaffolding in `correctionRoutes.test.ts`: local Postgres,
 * minimal user → session → household → membership chain, requests driven
 * through the Hono app. ASSISTANT_KEY_MASTER is intentionally omitted so
 * the planting-event pet spawn takes the deterministic fallback (no
 * Anthropic call).
 *
 * Run with:
 *
 *   bun test tests/integration/createReplay.test.ts
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
  const userId = uid('cr-user');
  const householdId = uid('cr-hh');
  const sessionId = uid('cr-sess');
  const sessionToken = uid('cr-tok');
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
  data?: Record<string, Record<string, unknown>>;
  error?: { code: string; message: string };
}

async function post(
  app: ReturnType<typeof createApp>,
  fx: Fixture,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Envelope }> {
  const res = await app.request(
    path,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${fx.sessionToken}`,
      },
      body: JSON.stringify(body),
    },
    TEST_ENV,
  );
  return { status: res.status, json: (await res.json()) as Envelope };
}

async function rowCount(table: string, id: string): Promise<number> {
  const rows = await sql.unsafe<{ n: number }[]>(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE id = $1`,
    [id],
  );
  return rows[0]!.n;
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

describe('POST /api/locations — client id + replay', () => {
  it('same client id POSTed twice → one row, second response is a 200 replay', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const id = `loc_local_${uid('rp')}`;
    const body = { id, name: 'Garage Shelf', sort_order: 3 };

    const first = await post(app, fx, '/api/locations', body);
    expect(first.status).toBe(200);
    expect(first.json.data!.location.id).toBe(id);

    const second = await post(app, fx, '/api/locations', body);
    expect(second.status).toBe(200);
    expect(second.json.ok).toBe(true);
    expect(second.json.data!.location.id).toBe(id);
    expect(second.json.data!.location.household_id).toBe(fx.householdId);
    expect(second.json.data!.location.name).toBe('Garage Shelf');
    expect(second.json.data!.location.sort_order).toBe(3);
    expect(second.json.data!.location.created_at).toBe(first.json.data!.location.created_at);
    expect(second.json.data!.location.deleted_at).toBeNull();

    expect(await rowCount('locations', id)).toBe(1);
  });

  it("rejects an empty id and does not replay another household's row", async () => {
    const fxA = await seedAuthFixture();
    const fxB = await seedAuthFixture();
    const app = createApp(TEST_ENV);

    const empty = await post(app, fxA, '/api/locations', { id: '', name: 'X' });
    expect(empty.status).toBe(400);
    expect(empty.json.error!.code).toBe('bad_request');

    const id = `loc_local_${uid('xhh')}`;
    const first = await post(app, fxA, '/api/locations', { id, name: 'A Shelf' });
    expect(first.status).toBe(200);

    const second = await post(app, fxB, '/api/locations', { id, name: 'B Shelf' });
    expect(second.status).toBe(409);
    expect(second.json.error!.code).toBe('conflict');

    const rows = await sql.unsafe<{ household_id: string }[]>(
      `SELECT household_id FROM locations WHERE id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.household_id).toBe(fxA.householdId);
  });
});

describe('POST /api/tags — client id + replay', () => {
  it('same client id POSTed twice → one row, second response is a 200 replay', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const id = `tag_local_${uid('rp')}`;
    const body = { id, name: 'Heirloom', color: '#aabbcc' };

    const first = await post(app, fx, '/api/tags', body);
    expect(first.status).toBe(200);
    expect(first.json.data!.tag.id).toBe(id);

    const second = await post(app, fx, '/api/tags', body);
    expect(second.status).toBe(200);
    expect(second.json.ok).toBe(true);
    expect(second.json.data!.tag.id).toBe(id);
    expect(second.json.data!.tag.household_id).toBe(fx.householdId);
    expect(second.json.data!.tag.name).toBe('Heirloom');
    expect(second.json.data!.tag.color).toBe('#aabbcc');
    expect(second.json.data!.tag.created_at).toBe(first.json.data!.tag.created_at);

    expect(await rowCount('tags', id)).toBe(1);
  });
});

describe('POST /api/beds — client id + replay', () => {
  it('same client id POSTed twice → one row, second response is a 200 replay', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const id = `bed_local_${uid('rp')}`;
    const body = { id, name: 'North Bed', width_feet: 4, length_feet: 8.5 };

    const first = await post(app, fx, '/api/beds', body);
    expect(first.status).toBe(200);
    expect(first.json.data!.bed.id).toBe(id);

    const second = await post(app, fx, '/api/beds', body);
    expect(second.status).toBe(200);
    expect(second.json.ok).toBe(true);
    expect(second.json.data!.bed.id).toBe(id);
    expect(second.json.data!.bed.household_id).toBe(fx.householdId);
    expect(second.json.data!.bed.name).toBe('North Bed');
    // Replay round-trips NUMERIC through the same number coercion as a
    // fresh create.
    expect(second.json.data!.bed.width_feet).toBe(4);
    expect(second.json.data!.bed.length_feet).toBe(8.5);
    expect(second.json.data!.bed.created_at).toBe(first.json.data!.bed.created_at);

    expect(await rowCount('beds', id)).toBe(1);
  });
});

describe('POST /api/planting-events — client id + replay', () => {
  it('same client id POSTed twice → one row, 200 replay, and NO duplicate journal/checklist seeding', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const id = `pe_local_${uid('rp')}`;
    const body = { id, kind: 'sowing', planned_for: '2026-06-15' };

    const first = await post(app, fx, '/api/planting-events', body);
    expect(first.status).toBe(200);
    expect(first.json.data!.planting_event.id).toBe(id);
    // Pet identity rolled on the original create.
    expect(first.json.data!.planting_event.pet_seed).toBeTruthy();

    const second = await post(app, fx, '/api/planting-events', body);
    expect(second.status).toBe(200);
    expect(second.json.ok).toBe(true);
    expect(second.json.data!.planting_event.id).toBe(id);
    expect(second.json.data!.planting_event.household_id).toBe(fx.householdId);
    expect(second.json.data!.planting_event.planned_for).toBe('2026-06-15');
    expect(second.json.data!.planting_event.created_at).toBe(
      first.json.data!.planting_event.created_at,
    );
    // Replay returns the ORIGINAL pet identity, not a re-roll.
    expect(second.json.data!.planting_event.pet_seed).toBe(
      first.json.data!.planting_event.pet_seed,
    );

    expect(await rowCount('planting_events', id)).toBe(1);

    // The auto-seeded journal entry + checklist item exist exactly once.
    const entries = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM journal_entries WHERE planting_event_id = $1`,
      [id],
    );
    expect(entries).toHaveLength(1);
    const items = await sql.unsafe<{ n: number }[]>(
      `SELECT COUNT(*)::int AS n FROM journal_checklist_items WHERE entry_id = $1`,
      [entries[0]!.id],
    );
    expect(items[0]!.n).toBe(1);
  });

  it('FK failure (missing bed) leaves no event AND no journal seeding behind; retry after bed sync succeeds', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const bedId = `bed_local_${uid('fk')}`;
    const id = `pe_local_${uid('fk')}`;
    const body = { id, kind: 'sowing', planned_for: '2026-06-20', bed_id: bedId };

    const first = await post(app, fx, '/api/planting-events', body);
    expect(first.status).toBe(400);
    expect(first.json.error!.code).toBe('invalid_reference');
    expect(await rowCount('planting_events', id)).toBe(0);
    const orphans = await sql.unsafe<{ n: number }[]>(
      `SELECT COUNT(*)::int AS n FROM journal_entries WHERE planting_event_id = $1`,
      [id],
    );
    expect(orphans[0]!.n).toBe(0);

    // Parent bed syncs first (client-id create), then the retry lands.
    const bed = await post(app, fx, '/api/beds', { id: bedId, name: 'FK Bed' });
    expect(bed.status).toBe(200);

    const retry = await post(app, fx, '/api/planting-events', body);
    expect(retry.status).toBe(200);
    expect(retry.json.data!.planting_event.bed_id).toBe(bedId);
    expect(await rowCount('planting_events', id)).toBe(1);
    const seeded = await sql.unsafe<{ n: number }[]>(
      `SELECT COUNT(*)::int AS n FROM journal_entries WHERE planting_event_id = $1`,
      [id],
    );
    expect(seeded[0]!.n).toBe(1);
  });
});
