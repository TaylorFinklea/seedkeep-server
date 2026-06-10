/**
 * Stabilization B3 · integration tests for the delta-cursor tiebreaker
 * (contract decision 9).
 *
 * Strict `updated_at > since` cursors permanently skip rows that share
 * one updated_at millisecond across a page boundary. The fix is additive:
 * feeds accept an optional `since_id`, switch to the composite filter
 * `updated_at > since OR (updated_at = since AND id > since_id)` with
 * `ORDER BY updated_at, id`, and every page emits `cursor_id` (the last
 * item's id) beside the existing `cursor`. Without `since_id` the legacy
 * strict behavior is preserved bit-for-bit.
 *
 * Feeds covered here (one per SQL-builder idiom):
 *   - locations  — fixed positional params (also beds/tags/planting-events)
 *   - seeds      — `?`-rewriting addWhere builder
 *   - journal    — wheres[] + p-counter builder with extra entity filters
 *   - assistant  — wheres[] builder, DTO-mapped envelope
 *   - departures — primary key is planting_event_id, custom id accessor
 *   - corrections /mine — hand-rolled lookahead pagination
 *
 * Run with:
 *
 *   bun test tests/integration/deltaTiebreaker.test.ts
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
  catalogIds: new Set<string>(),
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
  const userId = uid('dt-user');
  const householdId = uid('dt-hh');
  const sessionId = uid('dt-sess');
  const sessionToken = uid('dt-tok');
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

interface DeltaEnvelope<T> {
  ok: boolean;
  data: {
    items: T[];
    cursor: number;
    cursor_id: string | null;
    has_more: boolean;
  };
}

async function getJson<T>(
  app: ReturnType<typeof createApp>,
  fx: Fixture,
  path: string,
): Promise<DeltaEnvelope<T>> {
  const res = await app.request(
    path,
    { method: 'GET', headers: { Authorization: `Bearer ${fx.sessionToken}` } },
    TEST_ENV,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as DeltaEnvelope<T>;
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
  for (const id of cleanup.catalogIds) {
    await sql.unsafe(`DELETE FROM catalog_seeds WHERE id = $1`, [id]).catch(() => {});
  }
  await sql.end({ timeout: 5 });
});

describe('GET /api/locations — tie at the page boundary', () => {
  it('since_id fetches the tied row the legacy strict cursor drops', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const T = 1_720_000_000_000;
    // Three rows sharing ONE updated_at millisecond; ids sort a < b < c.
    const base = uid('loc-tie');
    const ids = [`${base}-a`, `${base}-b`, `${base}-c`];
    for (const id of ids) {
      await sql.unsafe(
        `INSERT INTO locations (id, household_id, name, sort_order, created_at, updated_at)
         VALUES ($1, $2, $3, 0, $4, $4)`,
        [id, fx.householdId, `Loc ${id.slice(-1)}`, T],
      );
    }

    // Page 1 stops mid-tie.
    const page1 = await getJson<{ id: string }>(app, fx, '/api/locations?since=0&limit=2');
    expect(page1.data.items.map((r) => r.id)).toEqual([ids[0], ids[1]]);
    expect(page1.data.cursor).toBe(T);
    expect(page1.data.cursor_id).toBe(ids[1]);
    expect(page1.data.has_more).toBe(true);

    // Legacy resume (no since_id): the strict filter drops the tied row —
    // this is the bug the tiebreaker exists for.
    const legacy = await getJson<{ id: string }>(app, fx, `/api/locations?since=${T}&limit=2`);
    expect(legacy.data.items).toEqual([]);

    // Composite resume: the tied row comes back.
    const page2 = await getJson<{ id: string }>(
      app, fx, `/api/locations?since=${T}&since_id=${ids[1]}&limit=2`,
    );
    expect(page2.data.items.map((r) => r.id)).toEqual([ids[2]]);
    expect(page2.data.cursor).toBe(T);
    expect(page2.data.cursor_id).toBe(ids[2]);
    expect(page2.data.has_more).toBe(false);

    // Empty page echoes the cursor pair back unchanged.
    const page3 = await getJson<{ id: string }>(
      app, fx, `/api/locations?since=${T}&since_id=${ids[2]}&limit=2`,
    );
    expect(page3.data.items).toEqual([]);
    expect(page3.data.cursor).toBe(T);
    expect(page3.data.cursor_id).toBe(ids[2]);
  });

  it('legacy paging without since_id is unchanged (distinct timestamps)', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const base = 1_720_100_000_000;
    const prefix = uid('loc-legacy');
    for (let i = 0; i < 3; i++) {
      await sql.unsafe(
        `INSERT INTO locations (id, household_id, name, sort_order, created_at, updated_at)
         VALUES ($1, $2, $3, 0, $4, $4)`,
        [`${prefix}-${i}`, fx.householdId, `Legacy ${i}`, base + i],
      );
    }

    const page1 = await getJson<{ id: string }>(app, fx, '/api/locations?since=0&limit=2');
    expect(page1.data.items.map((r) => r.id)).toEqual([`${prefix}-0`, `${prefix}-1`]);
    expect(page1.data.cursor).toBe(base + 1);
    expect(page1.data.has_more).toBe(true);
    // cursor_id rides along additively even for legacy requests.
    expect(page1.data.cursor_id).toBe(`${prefix}-1`);

    const page2 = await getJson<{ id: string }>(
      app, fx, `/api/locations?since=${page1.data.cursor}&limit=2`,
    );
    expect(page2.data.items.map((r) => r.id)).toEqual([`${prefix}-2`]);
    expect(page2.data.cursor).toBe(base + 2);
    expect(page2.data.has_more).toBe(false);
  });
});

describe('GET /api/seeds — tie at the page boundary', () => {
  it('since_id fetches the tied row', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const T = 1_720_200_000_000;
    const base = uid('seed-tie');
    const ids = [`${base}-a`, `${base}-b`, `${base}-c`];
    for (const id of ids) {
      await sql.unsafe(
        `INSERT INTO seeds (id, household_id, state, packet_count, source, created_at, updated_at)
         VALUES ($1, $2, 'active', 1, 'store', $3, $3)`,
        [id, fx.householdId, T],
      );
    }

    const page1 = await getJson<{ id: string }>(app, fx, '/api/seeds?since=0&limit=2');
    expect(page1.data.items.map((r) => r.id)).toEqual([ids[0], ids[1]]);
    expect(page1.data.cursor).toBe(T);
    expect(page1.data.cursor_id).toBe(ids[1]);
    expect(page1.data.has_more).toBe(true);

    const page2 = await getJson<{ id: string }>(
      app, fx, `/api/seeds?since=${T}&since_id=${ids[1]}&limit=2`,
    );
    expect(page2.data.items.map((r) => r.id)).toEqual([ids[2]]);
    expect(page2.data.cursor_id).toBe(ids[2]);
  });
});

describe('GET /api/journal — tie at the page boundary with entity filters', () => {
  it('since_id composes with the seed_id filter (param re-indexing)', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const T = 1_720_300_000_000;
    const seedId = uid('jr-seed');
    await sql.unsafe(
      `INSERT INTO seeds (id, household_id, state, packet_count, source, created_at, updated_at)
       VALUES ($1, $2, 'active', 1, 'store', $3, $3)`,
      [seedId, fx.householdId, T],
    );
    const base = uid('jr-tie');
    const ids = [`${base}-a`, `${base}-b`, `${base}-c`];
    for (const id of ids) {
      await sql.unsafe(
        `INSERT INTO journal_entries (id, household_id, occurred_on, body, seed_id, created_at, updated_at)
         VALUES ($1, $2, '2026-06-01', 'tie test', $3, $4, $4)`,
        [id, fx.householdId, seedId, T],
      );
    }

    const page1 = await getJson<{ id: string }>(
      app, fx, `/api/journal?since=0&limit=2&seed_id=${seedId}`,
    );
    expect(page1.data.items.map((r) => r.id)).toEqual([ids[0], ids[1]]);
    expect(page1.data.cursor).toBe(T);
    expect(page1.data.cursor_id).toBe(ids[1]);
    expect(page1.data.has_more).toBe(true);

    const page2 = await getJson<{ id: string }>(
      app, fx, `/api/journal?since=${T}&since_id=${ids[1]}&limit=2&seed_id=${seedId}`,
    );
    expect(page2.data.items.map((r) => r.id)).toEqual([ids[2]]);
    expect(page2.data.cursor_id).toBe(ids[2]);
  });
});

describe('GET /api/assistant/threads — tie at the page boundary', () => {
  it('since_id fetches the tied row', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const T = 1_720_400_000_000;
    const base = uid('th-tie');
    const ids = [`${base}-a`, `${base}-b`, `${base}-c`];
    for (const id of ids) {
      await sql.unsafe(
        `INSERT INTO assistant_threads (id, household_id, title, created_at, updated_at)
         VALUES ($1, $2, 'Tie test', $3, $3)`,
        [id, fx.householdId, T],
      );
    }

    const page1 = await getJson<{ id: string }>(app, fx, '/api/assistant/threads?since=0&limit=2');
    expect(page1.data.items.map((r) => r.id)).toEqual([ids[0], ids[1]]);
    expect(page1.data.cursor).toBe(T);
    expect(page1.data.cursor_id).toBe(ids[1]);
    expect(page1.data.has_more).toBe(true);

    const page2 = await getJson<{ id: string }>(
      app, fx, `/api/assistant/threads?since=${T}&since_id=${ids[1]}&limit=2`,
    );
    expect(page2.data.items.map((r) => r.id)).toEqual([ids[2]]);
    expect(page2.data.cursor_id).toBe(ids[2]);
  });
});

describe('GET /api/pets/departures — tie at the page boundary', () => {
  it('uses planting_event_id as the tiebreaker id', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const T = 1_720_500_000_000;
    const base = uid('dep-tie');
    const ids = [`${base}-a`, `${base}-b`, `${base}-c`];
    for (const id of ids) {
      await sql.unsafe(
        `INSERT INTO planting_events (id, household_id, kind, planned_for, created_at, updated_at)
         VALUES ($1, $2, 'sowing', '2026-06-15', $3, $3)`,
        [id, fx.householdId, T],
      );
      await sql.unsafe(
        `INSERT INTO pet_departures
           (planting_event_id, household_id, reason, departed_at, created_at, updated_at)
         VALUES ($1, $2, 'wilted_too_long', $3, $3, $3)`,
        [id, fx.householdId, T],
      );
    }

    const page1 = await getJson<{ planting_event_id: string }>(
      app, fx, '/api/pets/departures?since=0&limit=2',
    );
    expect(page1.data.items.map((r) => r.planting_event_id)).toEqual([ids[0], ids[1]]);
    expect(page1.data.cursor).toBe(T);
    expect(page1.data.cursor_id).toBe(ids[1]);
    expect(page1.data.has_more).toBe(true);

    const page2 = await getJson<{ planting_event_id: string }>(
      app, fx, `/api/pets/departures?since=${T}&since_id=${ids[1]}&limit=2`,
    );
    expect(page2.data.items.map((r) => r.planting_event_id)).toEqual([ids[2]]);
    expect(page2.data.cursor_id).toBe(ids[2]);
  });
});

describe('GET /api/catalog/corrections/mine — tie at the page boundary', () => {
  it('since_id resumes mid-tie through the lookahead pagination', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);

    const catalogId = uid('dt-cat');
    const now = Date.now();
    await sql.unsafe(
      `INSERT INTO catalog_seeds
         (id, common_name, status, created_at, updated_at, published_at)
       VALUES ($1, 'Tomato', 'published', $2, $2, $2)`,
      [catalogId, now],
    );
    cleanup.catalogIds.add(catalogId);

    const T = 1_720_600_000_000;
    const base = uid('cf-tie');
    const ids = [`${base}-a`, `${base}-b`, `${base}-c`];
    for (const id of ids) {
      await sql.unsafe(
        `INSERT INTO catalog_feedback
           (id, catalog_seed_id, household_id, user_id, body, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'tie test', 'open', $5, $5)`,
        [id, catalogId, fx.householdId, fx.userId, T],
      );
    }

    const page1 = await getJson<{ id: string }>(
      app, fx, '/api/catalog/corrections/mine?since=0&limit=2',
    );
    expect(page1.data.items.map((r) => r.id)).toEqual([ids[0], ids[1]]);
    expect(page1.data.cursor).toBe(T);
    expect(page1.data.cursor_id).toBe(ids[1]);
    expect(page1.data.has_more).toBe(true);

    // Legacy resume drops the tied row.
    const legacy = await getJson<{ id: string }>(
      app, fx, `/api/catalog/corrections/mine?since=${T}&limit=2`,
    );
    expect(legacy.data.items).toEqual([]);

    // Composite resume fetches it.
    const page2 = await getJson<{ id: string }>(
      app, fx, `/api/catalog/corrections/mine?since=${T}&since_id=${ids[1]}&limit=2`,
    );
    expect(page2.data.items.map((r) => r.id)).toEqual([ids[2]]);
    expect(page2.data.cursor_id).toBe(ids[2]);
    expect(page2.data.has_more).toBe(false);
  });
});
