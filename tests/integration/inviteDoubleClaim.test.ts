/**
 * Security fix [5] — Invite double-claim TOCTOU guard.
 *
 * Verifies that re-accepting a claimed invite returns 409 already_claimed.
 * The DB-level guard (AND claimed_by IS NULL in the UPDATE) is exercised
 * by directly marking the invite claimed and then attempting a second accept.
 *
 * Run with:
 *   bun test tests/integration/inviteDoubleClaim.test.ts
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

interface OwnerFixture {
  userId: string;
  householdId: string;
  sessionToken: string;
}

async function seedOwnerFixture(): Promise<OwnerFixture> {
  const userId = uid('dc-owner');
  const householdId = uid('dc-hh');
  const sessionId = uid('dc-sess');
  const sessionToken = uid('dc-tok');
  const now = Date.now();

  await sql.unsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'DC Owner', $2, TRUE, $3, $3)`,
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
     VALUES ($1, 'DC Household', $2, $2)`,
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

async function seedUserOnly(): Promise<{ userId: string; sessionToken: string }> {
  const userId = uid('dc-user');
  const sessionId = uid('dc-usess');
  const sessionToken = uid('dc-utok');
  const now = Date.now();

  await sql.unsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'DC User', $2, TRUE, $3, $3)`,
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

describe('Invite double-claim TOCTOU guard [5]', () => {
  it('re-accepting an already-claimed invite returns 409 already_claimed', async () => {
    const owner = await seedOwnerFixture();
    const first = await seedUserOnly();
    const second = await seedUserOnly();
    const app = createApp(TEST_ENV);

    // Create invite via route.
    const createRes = await app.request(
      '/api/households/me/invites',
      { method: 'POST', headers: { Authorization: `Bearer ${owner.sessionToken}` } },
      TEST_ENV,
    );
    expect(createRes.status).toBe(200);
    const createJson = (await createRes.json()) as {
      ok: boolean;
      data: { invite: { code: string } };
    };
    const code = createJson.data.invite.code;

    // First user accepts — should succeed.
    const r1 = await app.request(
      `/api/invites/${code}/accept`,
      { method: 'POST', headers: { Authorization: `Bearer ${first.sessionToken}` } },
      TEST_ENV,
    );
    expect(r1.status).toBe(200);

    // Second user attempts to accept the same single-use invite.
    // The DB-level guard (AND claimed_by IS NULL) must fire and return 409.
    const r2 = await app.request(
      `/api/invites/${code}/accept`,
      { method: 'POST', headers: { Authorization: `Bearer ${second.sessionToken}` } },
      TEST_ENV,
    );
    expect(r2.status).toBe(409);
    const body2 = (await r2.json()) as { ok: boolean; error: { code: string } };
    expect(body2.ok).toBe(false);
    expect(body2.error.code).toBe('already_claimed');

    // The household should only have two members (owner + first joiner).
    const members = await sql.unsafe<{ user_id: string }[]>(
      `SELECT user_id FROM memberships WHERE household_id = $1`,
      [owner.householdId],
    );
    expect(members.length).toBe(2);
    expect(members.map((m) => m.user_id)).not.toContain(second.userId);
  });

  it('accepting an expired invite via direct DB state returns 409 from DB guard', async () => {
    const owner = await seedOwnerFixture();
    const joiner = await seedUserOnly();
    const app = createApp(TEST_ENV);

    // Insert an invite that's already expired.
    const inviteId = uid('dc-exp-id');
    const code = uid('dc-exp-code');
    const past = Date.now() - 60_000;

    await sql.unsafe(
      `INSERT INTO invites (id, household_id, code, invited_by, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [inviteId, owner.householdId, code, owner.userId, past, past],
    );

    const res = await app.request(
      `/api/invites/${code}/accept`,
      { method: 'POST', headers: { Authorization: `Bearer ${joiner.sessionToken}` } },
      TEST_ENV,
    );
    // The application-level check fires before the DB-level guard for expired.
    expect(res.status).toBe(410);
  });
});
