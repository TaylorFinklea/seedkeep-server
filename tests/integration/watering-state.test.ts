/**
 * Integration tests for /api/households/:id/watering-state (Phase 4C).
 *
 * Mirrors the DB-integration shape of `src/routes/__tests__/pets-depart.test.ts`:
 * connect to local Postgres (DATABASE_URL or dev default), seed the minimal
 * auth chain (user → session → household → membership), drive requests
 * through the Hono app, and assert both response shape and persisted state.
 *
 * Run with:
 *
 *   bun test tests/integration/watering-state.test.ts
 *
 * Prerequisites:
 *   - Local Postgres reachable at DATABASE_URL
 *   - Migration 0019 applied (`bun run migrate`)
 *
 * Uses Bun's built-in test runner (`bun:test`) so the file runs cleanly
 * with `bun test` without invoking vitest.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import postgres, { type Sql } from 'postgres';
import { randomBytes } from 'node:crypto';
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

// ASSISTANT_KEY_MASTER is base64(32 random bytes). Generated per test
// run; the underlying key material never leaves the test process.
const TEST_MASTER_KEY = randomBytes(32).toString('base64');

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
  ASSISTANT_KEY_MASTER: TEST_MASTER_KEY,
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
  const userId = uid('test-user');
  const householdId = uid('test-hh');
  const sessionId = uid('test-sess');
  const sessionToken = uid('test-tok');
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

// Three well-defined ISO8601 timestamps with strictly increasing time.
// Using literal Z-suffixed strings keeps `expect(parse(...))` independent
// of the test machine's local TZ.
const T_EARLY = '2026-06-01T08:00:00.000Z';
const T_MID   = '2026-06-04T08:00:00.000Z';
const T_LATE  = '2026-06-07T08:00:00.000Z';

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

describe('GET /api/households/:id/watering-state', () => {
  it('returns null on a fresh household', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);

    const res = await app.request(
      `/api/households/${fx.householdId}/watering-state`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${fx.sessionToken}` },
      },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { last_watering_notification_at: string | null };
    };
    expect(json.ok).toBe(true);
    expect(json.data.last_watering_notification_at).toBeNull();
  });

  it('returns 404 when :id does not match the session household', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);

    const res = await app.request(
      `/api/households/some-other-household-id/watering-state`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${fx.sessionToken}` },
      },
      TEST_ENV,
    );
    expect(res.status).toBe(404);
  });

  it('returns 401 without an auth token', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);

    const res = await app.request(
      `/api/households/${fx.householdId}/watering-state`,
      { method: 'GET' },
      TEST_ENV,
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /api/households/:id/watering-state — round-trip', () => {
  it('GET → POST → GET round-trips the timestamp', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);

    // Pre-POST GET returns null.
    const before = await app.request(
      `/api/households/${fx.householdId}/watering-state`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${fx.sessionToken}` },
      },
      TEST_ENV,
    );
    const beforeJson = (await before.json()) as { data: { last_watering_notification_at: string | null } };
    expect(beforeJson.data.last_watering_notification_at).toBeNull();

    // POST sets the timestamp.
    const post = await app.request(
      `/api/households/${fx.householdId}/watering-state`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({ scheduled_for: T_MID }),
      },
      TEST_ENV,
    );
    expect(post.status).toBe(200);
    const postJson = (await post.json()) as {
      ok: boolean;
      data: { last_watering_notification_at: string | null };
    };
    expect(postJson.ok).toBe(true);
    expect(postJson.data.last_watering_notification_at).not.toBeNull();
    expect(new Date(postJson.data.last_watering_notification_at!).getTime()).toBe(Date.parse(T_MID));

    // Post-POST GET returns the stored value.
    const after = await app.request(
      `/api/households/${fx.householdId}/watering-state`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${fx.sessionToken}` },
      },
      TEST_ENV,
    );
    const afterJson = (await after.json()) as { data: { last_watering_notification_at: string | null } };
    expect(afterJson.data.last_watering_notification_at).not.toBeNull();
    expect(new Date(afterJson.data.last_watering_notification_at!).getTime()).toBe(Date.parse(T_MID));
  });
});

describe('POST /api/households/:id/watering-state — GREATEST semantics', () => {
  it('POST with an earlier timestamp returns the existing (later) value', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);

    // Seed with the mid timestamp.
    const seed = await app.request(
      `/api/households/${fx.householdId}/watering-state`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({ scheduled_for: T_MID }),
      },
      TEST_ENV,
    );
    expect(seed.status).toBe(200);

    // Earlier timestamp must NOT overwrite — server returns existing T_MID.
    const earlier = await app.request(
      `/api/households/${fx.householdId}/watering-state`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({ scheduled_for: T_EARLY }),
      },
      TEST_ENV,
    );
    expect(earlier.status).toBe(200);
    const earlierJson = (await earlier.json()) as {
      data: { last_watering_notification_at: string | null };
    };
    expect(earlierJson.data.last_watering_notification_at).not.toBeNull();
    expect(new Date(earlierJson.data.last_watering_notification_at!).getTime())
      .toBe(Date.parse(T_MID));
  });

  it('POST with a later timestamp updates the stored value', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);

    // Seed with the mid timestamp.
    await app.request(
      `/api/households/${fx.householdId}/watering-state`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({ scheduled_for: T_MID }),
      },
      TEST_ENV,
    );

    // Later timestamp advances.
    const later = await app.request(
      `/api/households/${fx.householdId}/watering-state`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({ scheduled_for: T_LATE }),
      },
      TEST_ENV,
    );
    expect(later.status).toBe(200);
    const laterJson = (await later.json()) as {
      data: { last_watering_notification_at: string | null };
    };
    expect(new Date(laterJson.data.last_watering_notification_at!).getTime())
      .toBe(Date.parse(T_LATE));

    // DB-side post-condition: column actually holds the later timestamp.
    const rows = await sql.unsafe<{ last_watering_notification_at: string | null }[]>(
      `SELECT last_watering_notification_at::text AS last_watering_notification_at
         FROM households WHERE id = $1`,
      [fx.householdId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.last_watering_notification_at).not.toBeNull();
    expect(new Date(rows[0]!.last_watering_notification_at!).getTime())
      .toBe(Date.parse(T_LATE));
  });

  it('POST with the same timestamp is a no-op (idempotent)', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);

    const first = await app.request(
      `/api/households/${fx.householdId}/watering-state`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({ scheduled_for: T_MID }),
      },
      TEST_ENV,
    );
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as {
      data: { last_watering_notification_at: string | null };
    };

    const second = await app.request(
      `/api/households/${fx.householdId}/watering-state`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({ scheduled_for: T_MID }),
      },
      TEST_ENV,
    );
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as {
      data: { last_watering_notification_at: string | null };
    };
    expect(secondJson.data.last_watering_notification_at)
      .toBe(firstJson.data.last_watering_notification_at);
  });
});

describe('POST /api/households/:id/watering-state — validation', () => {
  it('rejects a non-ISO8601 scheduled_for with 400', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);

    const res = await app.request(
      `/api/households/${fx.householdId}/watering-state`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({ scheduled_for: 'not-a-date' }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error?: { code: string } };
    expect(json.ok).toBe(false);
    expect(json.error?.code).toBe('bad_request');
  });

  it('rejects a missing scheduled_for with 400', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);

    const res = await app.request(
      `/api/households/${fx.householdId}/watering-state`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({}),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error?: { code: string } };
    expect(json.ok).toBe(false);
    expect(json.error?.code).toBe('bad_request');
  });

  it('returns 404 when POSTing to a non-session household id', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);

    const res = await app.request(
      `/api/households/some-other-household-id/watering-state`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({ scheduled_for: T_MID }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(404);
  });
});
