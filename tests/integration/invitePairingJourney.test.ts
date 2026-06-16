/**
 * M5 · integration tests for the household invite/accept pairing journey.
 *
 * Covers the multi-member household-formation path (households.ts:154-253),
 * which is the precondition for the multi-member account-deletion branches and
 * the sole guard on Phase-1 1:1 user-to-household enforcement. Exercises all
 * five branches: happy path, already_member (409), already_claimed (409),
 * expired (410), not_found (404).
 *
 * Run with:
 *   bun test tests/integration/invitePairingJourney.test.ts
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

/** Full fixture: user + session + household + owner membership. */
async function seedOwnerFixture(): Promise<OwnerFixture> {
  const userId = uid('inv-owner');
  const householdId = uid('inv-hh');
  const sessionId = uid('inv-sess');
  const sessionToken = uid('inv-tok');
  const now = Date.now();

  await sql.unsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'Owner User', $2, TRUE, $3, $3)`,
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
     VALUES ($1, 'Invite Household', $2, $2)`,
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

/** User-only fixture: user + session, NO household / membership. */
async function seedUserOnlyFixture(): Promise<{ userId: string; sessionToken: string }> {
  const userId = uid('inv-joiner');
  const sessionId = uid('inv-jsess');
  const sessionToken = uid('inv-jtok');
  const now = Date.now();

  await sql.unsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'Joiner User', $2, TRUE, $3, $3)`,
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

async function createInvite(app: ReturnType<typeof createApp>, owner: OwnerFixture): Promise<string> {
  const res = await app.request(
    '/api/households/me/invites',
    { method: 'POST', headers: { Authorization: `Bearer ${owner.sessionToken}` } },
    TEST_ENV,
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { ok: boolean; data: { invite: { code: string } } };
  expect(json.ok).toBe(true);
  return json.data.invite.code;
}

async function accept(
  app: ReturnType<typeof createApp>,
  sessionToken: string,
  code: string,
): Promise<Response> {
  return app.request(
    `/api/invites/${code}/accept`,
    { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` } },
    TEST_ENV,
  );
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

describe('Invite/accept household pairing', () => {
  it('happy path: a user with no household accepts an invite and joins as member', async () => {
    const owner = await seedOwnerFixture();
    const joiner = await seedUserOnlyFixture();
    const app = createApp(TEST_ENV);

    const code = await createInvite(app, owner);
    const res = await accept(app, joiner.sessionToken, code);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { household: { id: string }; role: string };
    };
    expect(json.ok).toBe(true);
    expect(json.data.role).toBe('member');
    expect(json.data.household.id).toBe(owner.householdId);

    // The household now has exactly two memberships.
    const members = await sql.unsafe<{ user_id: string; role: string }[]>(
      `SELECT user_id, role FROM memberships WHERE household_id = $1 ORDER BY joined_at ASC`,
      [owner.householdId],
    );
    expect(members.length).toBe(2);
    expect(members.map((m) => m.user_id)).toContain(joiner.userId);

    // The invite is marked single-use claimed by the joiner.
    const inv = await sql.unsafe<{ claimed_by: string | null }[]>(
      `SELECT claimed_by FROM invites WHERE code = $1`,
      [code],
    );
    expect(inv[0]!.claimed_by).toBe(joiner.userId);
  });

  it('already_member: a user who already belongs to a household is refused (409, 1:1 enforcement)', async () => {
    const owner = await seedOwnerFixture();
    const other = await seedOwnerFixture(); // already has their own household
    const app = createApp(TEST_ENV);

    const code = await createInvite(app, owner);
    const res = await accept(app, other.sessionToken, code);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(json.error.code).toBe('already_member');

    // Owner's household membership count is unchanged (the invite was not claimed).
    const members = await sql.unsafe<{ user_id: string }[]>(
      `SELECT user_id FROM memberships WHERE household_id = $1`,
      [owner.householdId],
    );
    expect(members.length).toBe(1);
  });

  it('already_claimed: a single-use invite cannot be claimed twice (409)', async () => {
    const owner = await seedOwnerFixture();
    const first = await seedUserOnlyFixture();
    const second = await seedUserOnlyFixture();
    const app = createApp(TEST_ENV);

    const code = await createInvite(app, owner);
    const r1 = await accept(app, first.sessionToken, code);
    expect(r1.status).toBe(200);

    const r2 = await accept(app, second.sessionToken, code);
    expect(r2.status).toBe(409);
    const json = (await r2.json()) as { ok: boolean; error: { code: string } };
    expect(json.error.code).toBe('already_claimed');
  });

  it('expired: an invite past its expiry is refused (410)', async () => {
    const owner = await seedOwnerFixture();
    const joiner = await seedUserOnlyFixture();
    const app = createApp(TEST_ENV);

    // The route always sets a future expiry, so insert an already-expired
    // invite directly to exercise the expiry branch.
    const inviteId = uid('inv-exp-id');
    const code = uid('inv-exp-code');
    const past = Date.now() - 60_000;
    await sql.unsafe(
      `INSERT INTO invites (id, household_id, code, invited_by, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [inviteId, owner.householdId, code, owner.userId, past, past],
    );

    const res = await accept(app, joiner.sessionToken, code);
    expect(res.status).toBe(410);
    const json = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(json.error.code).toBe('expired');
  });

  it('not_found: accepting a bogus code returns 404', async () => {
    const joiner = await seedUserOnlyFixture();
    const app = createApp(TEST_ENV);

    const res = await accept(app, joiner.sessionToken, `nope-${uid('x')}`);
    expect(res.status).toBe(404);
    const json = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(json.error.code).toBe('not_found');
  });
});
