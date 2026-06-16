/**
 * Security fixes [6] + [7] — PUT correction edit: AI cache invalidation
 * and DB-level TOCTOU guard.
 *
 * [6] Editing suggested_value clears the cached AI score fields.
 * [7] A locked/non-open correction returns 409 from the DB UPDATE guard.
 *
 * Run with:
 *   bun test tests/integration/correctionEditSecurity.test.ts
 *
 * Prerequisites:
 *   - Local Postgres reachable at DATABASE_URL
 *   - Migrations applied (`bun run migrate`)
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import postgres, { type Sql } from 'postgres';
import { nanoid } from 'nanoid';
import { createApp } from '../../src/index';
import type { Env } from '../../src/env';
import { randomBytes } from 'node:crypto';

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
  ADMIN_SECRET: 'test-admin-secret-please',
};

const cleanup = {
  userIds: new Set<string>(),
  householdIds: new Set<string>(),
  catalogIds: new Set<string>(),
  correctionIds: new Set<string>(),
};

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 12)}`;
}

interface Fixture {
  userId: string;
  householdId: string;
  sessionToken: string;
}

async function seedFixture(): Promise<Fixture> {
  const userId = uid('ces-user');
  const householdId = uid('ces-hh');
  const sessionId = uid('ces-sess');
  const sessionToken = uid('ces-tok');
  const now = Date.now();
  const eightDaysAgo = now - 8 * 86_400_000;

  await sql.unsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'CES User', $2, TRUE,
             to_timestamp($3 / 1000.0), to_timestamp($3 / 1000.0))`,
    [userId, `${userId}@example.invalid`, eightDaysAgo],
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
     VALUES ($1, 'CES Household', $2, $2)`,
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

async function seedCatalog(): Promise<string> {
  const id = uid('ces-cat');
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO catalog_seeds
       (id, common_name, days_to_maturity_min, days_to_maturity_max,
        status, created_at, updated_at, published_at)
     VALUES ($1, 'Tomato', 60, 80, 'published', $2::BIGINT, $2::BIGINT, $2::BIGINT)`,
    [id, now],
  );
  cleanup.catalogIds.add(id);
  return id;
}

async function insertCorrectionWithCachedScore(
  userId: string,
  householdId: string,
  catalogId: string,
): Promise<string> {
  const id = `cf_${nanoid(12)}`;
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO catalog_feedback
       (id, catalog_seed_id, household_id, user_id, body, field_name,
        suggested_value, value_type, catalog_seed_name,
        user_acknowledged_bounds, status, created_at, updated_at,
        ai_review_score, ai_self_confidence, ai_notes, ai_raw_response)
     VALUES ($1, $2, $3, $4, 'body', 'days_to_maturity_min', '70',
             'integer', 'Tomato', FALSE,
             'open', $5::BIGINT, $5::BIGINT,
             0.95, 0.9, 'good suggestion', '{"mocked":true}')`,
    [id, catalogId, householdId, userId, now],
  );
  cleanup.correctionIds.add(id);
  return id;
}

beforeAll(async () => {
  await sql`SELECT 1`;
});

afterAll(async () => {
  for (const id of cleanup.correctionIds) {
    await sql.unsafe(`DELETE FROM catalog_feedback WHERE id = $1`, [id]).catch(() => {});
  }
  for (const id of cleanup.catalogIds) {
    await sql.unsafe(`DELETE FROM catalog_feedback WHERE catalog_seed_id = $1`, [id]).catch(() => {});
    await sql.unsafe(`DELETE FROM catalog_seeds WHERE id = $1`, [id]).catch(() => {});
  }
  for (const id of cleanup.householdIds) {
    await sql.unsafe(`DELETE FROM households WHERE id = $1`, [id]).catch(() => {});
  }
  for (const id of cleanup.userIds) {
    await sql.unsafe(`DELETE FROM "user" WHERE id = $1`, [id]).catch(() => {});
  }
  await sql.end({ timeout: 5 });
});

describe('PUT correction edit — AI cache invalidation [6]', () => {
  it('editing suggested_value clears ai_review_score, ai_self_confidence, ai_notes, ai_raw_response, ai_next_attempt_at', async () => {
    const fx = await seedFixture();
    const catalogId = await seedCatalog();
    const app = createApp(TEST_ENV);

    const corrId = await insertCorrectionWithCachedScore(fx.userId, fx.householdId, catalogId);

    // Verify cached score is set before edit.
    const before = await sql.unsafe<{
      ai_review_score: number | null;
      ai_self_confidence: number | null;
      ai_notes: string | null;
    }[]>(
      `SELECT ai_review_score, ai_self_confidence, ai_notes FROM catalog_feedback WHERE id = $1`,
      [corrId],
    );
    expect(before[0]?.ai_review_score).not.toBeNull();

    // Edit suggested_value via PUT route.
    const res = await app.request(
      `/api/catalog/${catalogId}/corrections/${corrId}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({ suggested_value: '75' }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(200);

    // All cached AI fields must be cleared.
    const after = await sql.unsafe<{
      ai_review_score: number | null;
      ai_self_confidence: number | null;
      ai_notes: string | null;
      ai_raw_response: unknown;
      ai_next_attempt_at: number | null;
      suggested_value: string | null;
    }[]>(
      `SELECT ai_review_score, ai_self_confidence, ai_notes,
              ai_raw_response, ai_next_attempt_at, suggested_value
         FROM catalog_feedback WHERE id = $1`,
      [corrId],
    );
    expect(after[0]?.ai_review_score).toBeNull();
    expect(after[0]?.ai_self_confidence).toBeNull();
    expect(after[0]?.ai_notes).toBeNull();
    expect(after[0]?.ai_raw_response).toBeNull();
    expect(after[0]?.ai_next_attempt_at).toBeNull();
    expect(after[0]?.suggested_value).toBe('75');
  });

  it('editing body only (no suggested_value) does NOT clear ai_review_score', async () => {
    const fx = await seedFixture();
    const catalogId = await seedCatalog();
    const app = createApp(TEST_ENV);

    const corrId = await insertCorrectionWithCachedScore(fx.userId, fx.householdId, catalogId);

    const res = await app.request(
      `/api/catalog/${catalogId}/corrections/${corrId}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({ body: 'updated body text' }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(200);

    const after = await sql.unsafe<{ ai_review_score: number | null }[]>(
      `SELECT ai_review_score FROM catalog_feedback WHERE id = $1`,
      [corrId],
    );
    // Score retained — only suggested_value changes invalidate it.
    expect(after[0]?.ai_review_score).not.toBeNull();
  });
});

describe('PUT correction edit — TOCTOU DB guard [7]', () => {
  it('locked correction (ai_locked_at IS NOT NULL) returns 409 from DB guard', async () => {
    const fx = await seedFixture();
    const catalogId = await seedCatalog();
    const app = createApp(TEST_ENV);

    const corrId = await insertCorrectionWithCachedScore(fx.userId, fx.householdId, catalogId);

    // Simulate worker claiming the row after the route's read but before the UPDATE.
    await sql.unsafe(
      `UPDATE catalog_feedback SET ai_locked_at = $1 WHERE id = $2`,
      [Date.now(), corrId],
    );

    const res = await app.request(
      `/api/catalog/${catalogId}/corrections/${corrId}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({ suggested_value: '80' }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('no_longer_editable');
  });

  it('non-open correction (status != open) returns 409 from DB guard', async () => {
    const fx = await seedFixture();
    const catalogId = await seedCatalog();
    const app = createApp(TEST_ENV);

    const corrId = await insertCorrectionWithCachedScore(fx.userId, fx.householdId, catalogId);

    // Mark as reviewed (terminal) before the route checks.
    await sql.unsafe(
      `UPDATE catalog_feedback SET status = 'reviewed', reviewed_at = $1,
          dismissed_reason = 'ai_low_confidence'
        WHERE id = $2`,
      [Date.now(), corrId],
    );

    const res = await app.request(
      `/api/catalog/${catalogId}/corrections/${corrId}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({ suggested_value: '80' }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(409);
  });
});
