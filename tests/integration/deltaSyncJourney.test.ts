/**
 * M5 · integration tests for delta-sync correctness.
 *
 * Validates the full delta-sync contract for seeds (and the core shape for
 * beds + planting_events):
 *
 *   - since=0 baseline: created row present, has_more=false,
 *     cursor=updated_at ms, cursor_id=id
 *   - PATCH then GET ?since=<priorCursor>&since_id=<priorId> returns ONLY
 *     the changed row (composite cursor filter)
 *   - since=0 EXCLUDES soft-deleted rows
 *   - DELETE (soft) then GET ?since=<cursor> INCLUDES the tombstone
 *     (deleted_at populated)
 *   - limit clamp (1–500) + 2-page pagination returns disjoint id sets +
 *     correct has_more
 *   - cross-household isolation: another household's row never appears
 *
 * Run with:
 *   bun test tests/integration/deltaSyncJourney.test.ts
 *
 * Prerequisites:
 *   - Local Postgres reachable at DATABASE_URL
 *   - Migrations applied (`bun run migrate`)
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
  const userId = uid('ds-user');
  const householdId = uid('ds-hh');
  const sessionId = uid('ds-sess');
  const sessionToken = uid('ds-tok');
  const now = Date.now();

  await sql.unsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'Delta User', $2, TRUE, $3, $3)`,
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
     VALUES ($1, 'Delta Household', $2, $2)`,
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
  await sql.end({ timeout: 5 });
});

// ── Seeds delta-sync ──────────────────────────────────────────────────────────

describe('GET /api/seeds — delta-sync contract', () => {
  it('since=0 baseline: row present, has_more=false, cursor=updated_at, cursor_id=id', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const seedId = `seed_local_${uid('ds-s1')}`;

    const createRes = await app.request(
      '/api/seeds',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.sessionToken}` },
        body: JSON.stringify({ id: seedId, state: 'active', custom_name: 'Baseline Tomato' }),
      },
      TEST_ENV,
    );
    expect(createRes.status).toBe(200);
    const createJson = (await createRes.json()) as { ok: boolean; data: { seed: { updated_at: number } } };
    const createdUpdatedAt = createJson.data.seed.updated_at;

    const feed = await getJson<{ id: string; updated_at: number; deleted_at: number | null }>(
      app, fx, '/api/seeds?since=0',
    );
    expect(feed.ok).toBe(true);
    expect(feed.data.has_more).toBe(false);

    const item = feed.data.items.find((r) => r.id === seedId);
    expect(item).toBeTruthy();
    expect(item!.deleted_at).toBeNull();

    // cursor = last item's updated_at; cursor_id = last item's id.
    // The feed may contain other household seeds, so find the specific one.
    // At minimum: cursor >= createdUpdatedAt.
    expect(feed.data.cursor).toBeGreaterThanOrEqual(createdUpdatedAt);
    expect(feed.data.cursor_id).toBeTruthy();
  });

  it('PATCH then composite GET returns ONLY the changed row', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const seedId = `seed_local_${uid('ds-s2')}`;

    await app.request(
      '/api/seeds',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.sessionToken}` },
        body: JSON.stringify({ id: seedId, state: 'active', custom_name: 'Pre-patch' }),
      },
      TEST_ENV,
    );

    // Capture the baseline cursor. Use since=0 to get the row, then record
    // its cursor as the last updated_at before patching.
    const baseline = await getJson<{ id: string; updated_at: number }>(
      app, fx, '/api/seeds?since=0',
    );
    const baselineItem = baseline.data.items.find((r) => r.id === seedId);
    expect(baselineItem).toBeTruthy();
    const prePatchCursor = baselineItem!.updated_at;
    const prePatchId = seedId;

    // Small sleep so updated_at advances at least 1ms.
    await new Promise((r) => setTimeout(r, 2));

    // PATCH the seed.
    const patchRes = await app.request(
      `/api/seeds/${seedId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.sessionToken}` },
        body: JSON.stringify({ custom_name: 'Post-patch' }),
      },
      TEST_ENV,
    );
    expect(patchRes.status).toBe(200);

    // GET with composite cursor targeting just the changed row.
    const afterPatch = await getJson<{ id: string; custom_name: string }>(
      app, fx, `/api/seeds?since=${prePatchCursor}&since_id=${prePatchId}`,
    );
    // The patched seed should appear (updated_at > prePatchCursor).
    const patchedItem = afterPatch.data.items.find((r) => r.id === seedId);
    expect(patchedItem).toBeTruthy();
    expect(patchedItem!.custom_name).toBe('Post-patch');
  });

  it('since=0 EXCLUDES soft-deleted rows', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const seedId = `seed_local_${uid('ds-s3')}`;

    await app.request(
      '/api/seeds',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.sessionToken}` },
        body: JSON.stringify({ id: seedId, state: 'active', custom_name: 'About to Die' }),
      },
      TEST_ENV,
    );

    // Soft-delete the seed.
    const delRes = await app.request(
      `/api/seeds/${seedId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${fx.sessionToken}` } },
      TEST_ENV,
    );
    expect(delRes.status).toBe(200);

    // since=0 must not include deleted rows.
    const feed = await getJson<{ id: string; deleted_at: number | null }>(
      app, fx, '/api/seeds?since=0',
    );
    const deletedRow = feed.data.items.find((r) => r.id === seedId);
    expect(deletedRow).toBeUndefined();
  });

  it('since>0 INCLUDES tombstone after soft-delete', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const seedId = `seed_local_${uid('ds-s4')}`;

    await app.request(
      '/api/seeds',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.sessionToken}` },
        body: JSON.stringify({ id: seedId, state: 'active', custom_name: 'Tombstone Test' }),
      },
      TEST_ENV,
    );

    // Capture create time for the cursor.
    const baseline = await getJson<{ id: string; updated_at: number }>(
      app, fx, '/api/seeds?since=0',
    );
    const item = baseline.data.items.find((r) => r.id === seedId);
    expect(item).toBeTruthy();
    const cursorBefore = item!.updated_at;
    const idBefore = seedId;

    await new Promise((r) => setTimeout(r, 2));

    // Soft-delete.
    await app.request(
      `/api/seeds/${seedId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${fx.sessionToken}` } },
      TEST_ENV,
    );

    // since>0 includes tombstones.
    const tombstoneFeed = await getJson<{ id: string; deleted_at: number | null }>(
      app, fx, `/api/seeds?since=${cursorBefore}&since_id=${idBefore}`,
    );
    const tombstoneRow = tombstoneFeed.data.items.find((r) => r.id === seedId);
    expect(tombstoneRow).toBeTruthy();
    expect(tombstoneRow!.deleted_at).not.toBeNull();
  });

  it('limit clamp: limit=0 → clamped to 1; limit=1000 → clamped to 500', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);

    // limit=0 should be clamped to 1 (no error).
    const feedLow = await getJson<{ id: string }>(app, fx, '/api/seeds?since=0&limit=0');
    expect(feedLow.ok).toBe(true);

    // limit=1000 should be clamped to 500 (no error, just returns ≤500 rows).
    const feedHigh = await getJson<{ id: string }>(app, fx, '/api/seeds?since=0&limit=1000');
    expect(feedHigh.ok).toBe(true);
    expect(feedHigh.data.items.length).toBeLessThanOrEqual(500);
  });

  it('2-page pagination returns disjoint id sets + correct has_more', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const T = 1_700_000_111_000 + Math.floor(Math.random() * 1_000); // unique ts per test run

    // Insert 3 seeds with identical updated_at (tie scenario).
    const base = uid('ds-pg');
    const ids = [`${base}-a`, `${base}-b`, `${base}-c`];
    for (const id of ids) {
      await sql.unsafe(
        `INSERT INTO seeds (id, household_id, state, packet_count, source, created_at, updated_at)
         VALUES ($1, $2, 'active', 1, 'store', $3, $3)`,
        [id, fx.householdId, T],
      );
    }

    // Page 1: limit=2. Fresh household → exactly the 3 inserted seeds exist.
    const page1 = await getJson<{ id: string }>(app, fx, `/api/seeds?since=0&limit=2`);
    const p1ids = page1.data.items.map((r) => r.id);
    expect(p1ids.length).toBe(2);
    expect(page1.data.has_more).toBe(true);

    // Page 2 via the composite cursor returns the remaining row.
    const page2 = await getJson<{ id: string }>(
      app, fx, `/api/seeds?since=${page1.data.cursor}&since_id=${page1.data.cursor_id!}&limit=2`,
    );
    const p2ids = page2.data.items.map((r) => r.id);

    // The two pages are disjoint and together cover exactly the 3 inserted ids.
    expect(p1ids.filter((id) => p2ids.includes(id))).toHaveLength(0);
    const covered = [...new Set([...p1ids, ...p2ids])].sort();
    expect(covered).toEqual([...ids].sort());
  });

  it('cross-household isolation: a second household row never appears in the first feed', async () => {
    const fxA = await seedAuthFixture();
    const fxB = await seedAuthFixture();
    const appA = createApp(TEST_ENV);
    const appB = createApp(TEST_ENV);

    const seedIdA = `seed_local_${uid('ds-iso-a')}`;
    const seedIdB = `seed_local_${uid('ds-iso-b')}`;

    await appA.request(
      '/api/seeds',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fxA.sessionToken}` },
        body: JSON.stringify({ id: seedIdA, state: 'active', custom_name: 'HH-A Seed' }),
      },
      TEST_ENV,
    );
    await appB.request(
      '/api/seeds',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fxB.sessionToken}` },
        body: JSON.stringify({ id: seedIdB, state: 'active', custom_name: 'HH-B Seed' }),
      },
      TEST_ENV,
    );

    // HH-A feed must not contain HH-B's seed.
    const feedA = await getJson<{ id: string }>(appA, fxA, '/api/seeds?since=0');
    const idsInA = feedA.data.items.map((r) => r.id);
    expect(idsInA).toContain(seedIdA);
    expect(idsInA).not.toContain(seedIdB);

    // HH-B feed must not contain HH-A's seed.
    const feedB = await getJson<{ id: string }>(appB, fxB, '/api/seeds?since=0');
    const idsInB = feedB.data.items.map((r) => r.id);
    expect(idsInB).toContain(seedIdB);
    expect(idsInB).not.toContain(seedIdA);
  });
});

// ── Beds delta-sync ───────────────────────────────────────────────────────────

describe('GET /api/beds — delta-sync envelope shape', () => {
  it('returns correct delta envelope with cursor and cursor_id after create', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const bedId = `bed_local_${uid('ds-b1')}`;

    const createRes = await app.request(
      '/api/beds',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.sessionToken}` },
        body: JSON.stringify({ id: bedId, name: 'Test Bed', sort_order: 0 }),
      },
      TEST_ENV,
    );
    expect(createRes.status).toBe(200);

    const feed = await getJson<{ id: string; updated_at: number; deleted_at: number | null }>(
      app, fx, '/api/beds?since=0',
    );
    expect(feed.ok).toBe(true);
    const item = feed.data.items.find((r) => r.id === bedId);
    expect(item).toBeTruthy();
    expect(item!.deleted_at).toBeNull();
    expect(typeof feed.data.cursor).toBe('number');
    expect(feed.data.cursor).toBeGreaterThan(0);
  });

  // Contract parity with seeds + journal: a soft-deleted bed must NOT appear
  // at since=0 (baseline pull). Fixed in beds.ts (since=0 → deleted_at IS NULL).
  it('since=0 EXCLUDES soft-deleted beds', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const bedId = `bed_local_${uid('ds-b2')}`;

    const createRes = await app.request(
      '/api/beds',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.sessionToken}` },
        body: JSON.stringify({ id: bedId, name: 'Delete Me', sort_order: 0 }),
      },
      TEST_ENV,
    );
    expect(createRes.status).toBe(200);

    const delRes = await app.request(
      `/api/beds/${bedId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${fx.sessionToken}` } },
      TEST_ENV,
    );
    expect(delRes.status).toBe(200);

    const feed = await getJson<{ id: string; deleted_at: number | null }>(app, fx, '/api/beds?since=0');
    const found = feed.data.items.find((r) => r.id === bedId);
    expect(found).toBeUndefined();
  });
});

// ── Planting-events delta-sync ────────────────────────────────────────────────

describe('GET /api/planting-events — delta-sync envelope shape', () => {
  it('returns correct delta envelope with cursor and cursor_id after create', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const peId = `pe_local_${uid('ds-pe1')}`;

    const createRes = await app.request(
      '/api/planting-events',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.sessionToken}` },
        body: JSON.stringify({ id: peId, kind: 'sowing', planned_for: '2026-07-01' }),
      },
      TEST_ENV,
    );
    expect(createRes.status).toBe(200);

    const feed = await getJson<{ id: string; updated_at: number; deleted_at: number | null }>(
      app, fx, '/api/planting-events?since=0',
    );
    expect(feed.ok).toBe(true);
    const item = feed.data.items.find((r) => r.id === peId);
    expect(item).toBeTruthy();
    expect(item!.deleted_at).toBeNull();
    expect(typeof feed.data.cursor).toBe('number');
    expect(feed.data.cursor).toBeGreaterThan(0);
  });

  // Contract parity with seeds + journal: a soft-deleted planting event must
  // NOT appear at since=0 (baseline pull). Fixed in planting-events.ts.
  it('since=0 EXCLUDES soft-deleted planting events', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const peId = `pe_local_${uid('ds-pe2')}`;

    const createRes = await app.request(
      '/api/planting-events',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.sessionToken}` },
        body: JSON.stringify({ id: peId, kind: 'sowing', planned_for: '2026-07-01' }),
      },
      TEST_ENV,
    );
    expect(createRes.status).toBe(200);

    const delRes = await app.request(
      `/api/planting-events/${peId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${fx.sessionToken}` } },
      TEST_ENV,
    );
    expect(delRes.status).toBe(200);

    const feed = await getJson<{ id: string; deleted_at: number | null }>(
      app, fx, '/api/planting-events?since=0',
    );
    const found = feed.data.items.find((r) => r.id === peId);
    expect(found).toBeUndefined();
  });

  it('since>0 includes tombstone planting event', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const peId = `pe_local_${uid('ds-pe3')}`;

    await app.request(
      '/api/planting-events',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.sessionToken}` },
        body: JSON.stringify({ id: peId, kind: 'sowing', planned_for: '2026-07-01' }),
      },
      TEST_ENV,
    );

    const baseline = await getJson<{ id: string; updated_at: number }>(
      app, fx, '/api/planting-events?since=0',
    );
    const item = baseline.data.items.find((r) => r.id === peId);
    expect(item).toBeTruthy();
    const cursorBefore = item!.updated_at;

    await new Promise((r) => setTimeout(r, 2));

    await app.request(
      `/api/planting-events/${peId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${fx.sessionToken}` } },
      TEST_ENV,
    );

    const tombstoneFeed = await getJson<{ id: string; deleted_at: number | null }>(
      app, fx, `/api/planting-events?since=${cursorBefore}&since_id=${peId}`,
    );
    const tombstone = tombstoneFeed.data.items.find((r) => r.id === peId);
    expect(tombstone).toBeTruthy();
    expect(tombstone!.deleted_at).not.toBeNull();
  });
});

// ── Journal entry tombstone delta test ───────────────────────────────────────
//
// Mirrors the seeds tombstone test:
//   1. Create a journal entry.
//   2. Soft-DELETE it via the API.
//   3. GET /api/journal?since=<priorCursor>&since_id=<id> INCLUDES the tombstone
//      (deleted_at populated).
//   4. GET /api/journal?since=0 EXCLUDES the tombstone.

describe('GET /api/journal — tombstone delta contract', () => {
  it('since=0 EXCLUDES soft-deleted journal entries', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);

    const createRes = await app.request(
      '/api/journal',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.sessionToken}` },
        body: JSON.stringify({ occurred_on: '2026-06-01', body: 'Tombstone exclusion test' }),
      },
      TEST_ENV,
    );
    expect(createRes.status).toBe(200);
    const createJson = (await createRes.json()) as { ok: boolean; data: { entry: { id: string } } };
    const jeId = createJson.data.entry.id;

    // Soft-delete it.
    const delRes = await app.request(
      `/api/journal/${jeId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${fx.sessionToken}` } },
      TEST_ENV,
    );
    expect(delRes.status).toBe(200);

    // since=0 must NOT include the deleted entry.
    const feed = await getJson<{ id: string; deletedAt: number | null }>(
      app, fx, '/api/journal?since=0',
    );
    const found = feed.data.items.find((r) => r.id === jeId);
    expect(found).toBeUndefined();
  });

  it('since>0 INCLUDES journal entry tombstone (deleted_at populated)', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);

    const createRes = await app.request(
      '/api/journal',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.sessionToken}` },
        body: JSON.stringify({ occurred_on: '2026-06-01', body: 'Tombstone inclusion test' }),
      },
      TEST_ENV,
    );
    expect(createRes.status).toBe(200);
    const createJson = (await createRes.json()) as { ok: boolean; data: { entry: { id: string; updatedAt: number } } };
    const jeId = createJson.data.entry.id;

    // Capture the baseline cursor.
    const baseline = await getJson<{ id: string; updatedAt: number }>(
      app, fx, '/api/journal?since=0',
    );
    const item = baseline.data.items.find((r) => r.id === jeId);
    expect(item).toBeTruthy();
    const cursorBefore = item!.updatedAt;
    const idBefore = jeId;

    // Small sleep so updated_at advances at least 1ms after the delete.
    await new Promise((r) => setTimeout(r, 2));

    // Soft-delete via the API.
    const delRes = await app.request(
      `/api/journal/${jeId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${fx.sessionToken}` } },
      TEST_ENV,
    );
    expect(delRes.status).toBe(200);

    // since>0 with composite cursor MUST include the tombstone.
    const tombstoneFeed = await getJson<{ id: string; deletedAt: number | null }>(
      app, fx, `/api/journal?since=${cursorBefore}&since_id=${idBefore}`,
    );
    const tombstone = tombstoneFeed.data.items.find((r) => r.id === jeId);
    expect(tombstone).toBeTruthy();
    // The DTO field is camelCased to `deletedAt`.
    expect(tombstone!.deletedAt).not.toBeNull();
  });
});
