/**
 * M5 · integration tests for the full onboarding journey.
 *
 * One signed-in user threaded across the whole chain with DB post-conditions
 * verified at each step:
 *
 *   1. GET /api/me — identity probe returns user id
 *   2. POST /api/households — creates household + owner membership (idempotent)
 *   3. PUT /api/households/me/location — ZIP denormalized onto household row
 *   4. POST /api/seeds — creates a seed scoped to the household
 *   5. POST /api/beds — creates a bed scoped to the household
 *   6. POST /api/planting-events — creates event + seeded journal entry +
 *      'Watered' checklist item (pet spawn uses deterministic fallback)
 *   7. GET /api/journal?since=0 — returns the auto-seeded entry
 *   8. GET /api/planting-events — returns the created event
 *
 * Run with:
 *   bun test tests/integration/onboardingJourney.test.ts
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

// ANTHROPIC_API_KEY intentionally undefined and no household assistant_key
// so pet spawn takes the deterministic fallback — no live Anthropic call.
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
  zipCodes: new Set<string>(),
};

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 12)}`;
}

interface Fixture {
  userId: string;
  sessionToken: string;
}

async function seedAuthFixture(): Promise<Fixture> {
  const userId = uid('oj-user');
  const sessionId = uid('oj-sess');
  const sessionToken = uid('oj-tok');
  const now = Date.now();

  await sql.unsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'Onboarding User', $2, TRUE, $3, $3)`,
    [userId, `${userId}@example.invalid`, now],
  );
  cleanup.userIds.add(userId);

  await sql.unsafe(
    `INSERT INTO session (id, "expiresAt", token, "createdAt", "updatedAt",
                          "ipAddress", "userAgent", "userId")
     VALUES ($1, NOW() + INTERVAL '1 day', $2, NOW(), NOW(), NULL, NULL, $3)`,
    [sessionId, sessionToken, userId],
  );

  return { userId, sessionToken };
}

// Seed a test ZIP so PUT /api/households/me/location can resolve it.
const TEST_ZIP = '97401'; // Oregon ZIP in the 970-979 range -> region 'OR'
async function seedTestZip(): Promise<void> {
  await sql.unsafe(
    `INSERT INTO zip_locations (zip, latitude, longitude, usda_zone, avg_last_frost, avg_first_frost)
     VALUES ($1, 44.05, -123.09, '8b', 'Mar 25', 'Nov 01')
     ON CONFLICT (zip) DO NOTHING`,
    [TEST_ZIP],
  );
  cleanup.zipCodes.add(TEST_ZIP);
}

function authHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

beforeAll(async () => {
  await sql`SELECT 1`;
  await seedTestZip();
});

afterAll(async () => {
  for (const id of cleanup.householdIds) {
    await sql.unsafe(`DELETE FROM households WHERE id = $1`, [id]).catch(() => {});
  }
  for (const id of cleanup.userIds) {
    await sql.unsafe(`DELETE FROM "user" WHERE id = $1`, [id]).catch(() => {});
  }
  // Clean up seeded ZIP (it's a lookup table, not household data — leave it
  // since ON CONFLICT DO NOTHING means it may have existed before).
  await sql.end({ timeout: 5 });
});

describe('Onboarding journey — single user, end-to-end chain', () => {
  it('completes GET /me → POST /households (idempotent) → PUT location → POST seed → POST bed → POST planting-event → GET journal → GET planting-events', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);

    // ── Step 1: GET /api/me ────────────────────────────────────────────────
    const meRes = await app.request(
      '/api/me',
      { method: 'GET', headers: { Authorization: `Bearer ${fx.sessionToken}` } },
      TEST_ENV,
    );
    expect(meRes.status).toBe(200);
    const meJson = (await meRes.json()) as { ok: boolean; data: { user: { id: string } } };
    expect(meJson.ok).toBe(true);
    expect(meJson.data.user.id).toBe(fx.userId);

    // ── Step 2: POST /api/households (first call) ─────────────────────────
    const hhRes1 = await app.request(
      '/api/households',
      {
        method: 'POST',
        headers: authHeaders(fx.sessionToken),
        body: JSON.stringify({ name: 'Test Garden' }),
      },
      TEST_ENV,
    );
    expect(hhRes1.status).toBe(200);
    const hhJson1 = (await hhRes1.json()) as {
      ok: boolean;
      data: { household: { id: string }; role: string };
    };
    expect(hhJson1.ok).toBe(true);
    const householdId = hhJson1.data.household.id;
    expect(householdId).toBeTruthy();
    expect(hhJson1.data.role).toBe('owner');
    cleanup.householdIds.add(householdId);

    // Verify exactly 1 owner membership in DB.
    const memberRows = await sql.unsafe<{ user_id: string; role: string }[]>(
      `SELECT user_id, role FROM memberships WHERE household_id = $1 ORDER BY joined_at`,
      [householdId],
    );
    expect(memberRows.length).toBe(1);
    expect(memberRows[0]!.user_id).toBe(fx.userId);
    expect(memberRows[0]!.role).toBe('owner');

    // ── Step 2b: POST /api/households again (idempotent) ─────────────────
    const hhRes2 = await app.request(
      '/api/households',
      {
        method: 'POST',
        headers: authHeaders(fx.sessionToken),
        body: JSON.stringify({ name: 'Should Not Create Another' }),
      },
      TEST_ENV,
    );
    expect(hhRes2.status).toBe(200);
    const hhJson2 = (await hhRes2.json()) as {
      ok: boolean;
      data: { household: { id: string }; role: string };
    };
    expect(hhJson2.ok).toBe(true);
    // Same household_id — idempotent.
    expect(hhJson2.data.household.id).toBe(householdId);

    // Still exactly 1 owner membership after replay.
    const memberRows2 = await sql.unsafe<{ user_id: string }[]>(
      `SELECT user_id FROM memberships WHERE household_id = $1`,
      [householdId],
    );
    expect(memberRows2.length).toBe(1);

    // ── Step 3: PUT /api/households/me/location ───────────────────────────
    const locRes = await app.request(
      '/api/households/me/location',
      {
        method: 'PUT',
        headers: authHeaders(fx.sessionToken),
        body: JSON.stringify({ zip: TEST_ZIP }),
      },
      TEST_ENV,
    );
    expect(locRes.status).toBe(200);
    const locJson = (await locRes.json()) as { ok: boolean; data: { zip: string; usdaZone: string } };
    expect(locJson.ok).toBe(true);
    expect(locJson.data.zip).toBe(TEST_ZIP);

    // Verify lat/lon/usda_zone/frost_dates denormalized onto the household row.
    const hhRow = await sql.unsafe<{
      home_zip: string;
      latitude: string;
      longitude: string;
      usda_zone: string;
      avg_last_frost: string;
      avg_first_frost: string;
      region_id: string | null;
    }[]>(
      `SELECT home_zip, latitude::text, longitude::text, usda_zone,
              avg_last_frost, avg_first_frost, region_id
         FROM households WHERE id = $1`,
      [householdId],
    );
    expect(hhRow.length).toBe(1);
    expect(hhRow[0]!.home_zip).toBe(TEST_ZIP);
    expect(Number(hhRow[0]!.latitude)).toBeCloseTo(44.05, 2);
    expect(Number(hhRow[0]!.longitude)).toBeCloseTo(-123.09, 2);
    expect(hhRow[0]!.usda_zone).toBe('8b');
    expect(hhRow[0]!.avg_last_frost).toBe('Mar 25');
    expect(hhRow[0]!.avg_first_frost).toBe('Nov 01');
    // OR ZIP prefix -> region OR
    expect(hhRow[0]!.region_id).toBe('OR');

    // ── Step 4: POST /api/seeds ───────────────────────────────────────────
    const seedId = `seed_local_${uid('oj-seed')}`;
    const seedRes = await app.request(
      '/api/seeds',
      {
        method: 'POST',
        headers: authHeaders(fx.sessionToken),
        body: JSON.stringify({ id: seedId, state: 'active', custom_name: 'Cherokee Purple' }),
      },
      TEST_ENV,
    );
    expect(seedRes.status).toBe(200);
    const seedJson = (await seedRes.json()) as { ok: boolean; data: { seed: { id: string; household_id: string } } };
    expect(seedJson.ok).toBe(true);
    expect(seedJson.data.seed.id).toBe(seedId);
    expect(seedJson.data.seed.household_id).toBe(householdId);

    // Verify seed row in DB.
    const seedRows = await sql.unsafe<{ id: string; household_id: string }[]>(
      `SELECT id, household_id FROM seeds WHERE id = $1`,
      [seedId],
    );
    expect(seedRows.length).toBe(1);
    expect(seedRows[0]!.household_id).toBe(householdId);

    // ── Step 5: POST /api/beds ────────────────────────────────────────────
    const bedId = `bed_local_${uid('oj-bed')}`;
    const bedRes = await app.request(
      '/api/beds',
      {
        method: 'POST',
        headers: authHeaders(fx.sessionToken),
        body: JSON.stringify({ id: bedId, name: 'Main Bed', sort_order: 0 }),
      },
      TEST_ENV,
    );
    expect(bedRes.status).toBe(200);
    const bedJson = (await bedRes.json()) as { ok: boolean; data: { bed: { id: string; household_id: string } } };
    expect(bedJson.ok).toBe(true);
    expect(bedJson.data.bed.id).toBe(bedId);
    expect(bedJson.data.bed.household_id).toBe(householdId);

    // Verify bed row in DB.
    const bedRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM beds WHERE id = $1 AND household_id = $2`,
      [bedId, householdId],
    );
    expect(bedRows.length).toBe(1);

    // ── Step 6: POST /api/planting-events ────────────────────────────────
    const peId = `pe_local_${uid('oj-pe')}`;
    const plannedFor = '2026-06-20';
    const peRes = await app.request(
      '/api/planting-events',
      {
        method: 'POST',
        headers: authHeaders(fx.sessionToken),
        body: JSON.stringify({
          id: peId,
          kind: 'sowing',
          planned_for: plannedFor,
          seed_id: seedId,
          bed_id: bedId,
        }),
      },
      TEST_ENV,
    );
    expect(peRes.status).toBe(200);
    const peJson = (await peRes.json()) as {
      ok: boolean;
      data: { planting_event: { id: string; planned_for: string } };
    };
    expect(peJson.ok).toBe(true);
    expect(peJson.data.planting_event.id).toBe(peId);
    expect(peJson.data.planting_event.planned_for).toBe(plannedFor);

    // Verify exactly 1 journal_entries row with occurred_on=planned_for, body=''.
    const jeRows = await sql.unsafe<{
      id: string;
      occurred_on: string;
      body: string;
      planting_event_id: string;
    }[]>(
      `SELECT id, occurred_on::text AS occurred_on, body, planting_event_id
         FROM journal_entries
        WHERE planting_event_id = $1 AND household_id = $2`,
      [peId, householdId],
    );
    expect(jeRows.length).toBe(1);
    expect(jeRows[0]!.occurred_on).toBe(plannedFor);
    expect(jeRows[0]!.body).toBe('');
    const journalEntryId = jeRows[0]!.id;

    // Verify ≥1 journal_checklist_items for 'Watered', completed=false, sort_order=0.
    const checkRows = await sql.unsafe<{
      text: string;
      completed: boolean;
      sort_order: number;
    }[]>(
      `SELECT text, completed, sort_order FROM journal_checklist_items
        WHERE entry_id = $1 ORDER BY sort_order`,
      [journalEntryId],
    );
    expect(checkRows.length).toBeGreaterThanOrEqual(1);
    const wateredRow = checkRows.find((r) => r.text === 'Watered');
    expect(wateredRow).toBeTruthy();
    expect(wateredRow!.completed).toBe(false);
    expect(wateredRow!.sort_order).toBe(0);

    // ── Step 7: GET /api/journal?since=0 ─────────────────────────────────
    const jRes = await app.request(
      '/api/journal?since=0',
      { method: 'GET', headers: { Authorization: `Bearer ${fx.sessionToken}` } },
      TEST_ENV,
    );
    expect(jRes.status).toBe(200);
    const jJson = (await jRes.json()) as {
      ok: boolean;
      data: {
        items: { id: string }[];
        cursor: number;
        cursor_id: string | null;
        has_more: boolean;
      };
    };
    expect(jJson.ok).toBe(true);
    expect(jJson.data).toHaveProperty('items');
    expect(jJson.data).toHaveProperty('cursor');
    expect(jJson.data).toHaveProperty('cursor_id');
    expect(jJson.data).toHaveProperty('has_more');
    expect(jJson.data.has_more).toBe(false);
    const returnedIds = jJson.data.items.map((i) => i.id);
    expect(returnedIds).toContain(journalEntryId);

    // ── Step 8: GET /api/planting-events ─────────────────────────────────
    const peListRes = await app.request(
      '/api/planting-events?since=0',
      { method: 'GET', headers: { Authorization: `Bearer ${fx.sessionToken}` } },
      TEST_ENV,
    );
    expect(peListRes.status).toBe(200);
    const peListJson = (await peListRes.json()) as {
      ok: boolean;
      data: {
        items: { id: string }[];
        cursor: number;
        cursor_id: string | null;
        has_more: boolean;
      };
    };
    expect(peListJson.ok).toBe(true);
    const peIds = peListJson.data.items.map((i) => i.id);
    expect(peIds).toContain(peId);
  });
});
