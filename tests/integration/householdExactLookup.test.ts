/**
 * `GET /api/households/:id` — the exact-household lookup the
 * account-deletion handoff needs.
 *
 * Spec: seedkeep/.docs/ai/phases/2026-07-23-cloudkit-account-deletion-spec.md
 *
 * A verified transfer UPSERTs a second `memberships` row for the
 * successor (`account-deletion-transfers.ts`), so a user with two
 * memberships needs a way to ask for the SPECIFIC household a transfer
 * named rather than whichever one the "current household" heuristic
 * (`requireHousehold`: most-recently-joined) happens to resolve to.
 * These tests pin: a member gets back exactly the household they asked
 * for even when they belong to a second one, a non-member is refused
 * without revealing whether the id exists, and an unauthenticated
 * request is refused before either check runs.
 *
 * Run with:
 *   bun test tests/integration/householdExactLookup.test.ts
 *
 * Prerequisites:
 *   - Local Postgres reachable at DATABASE_URL
 *   - Migrations applied (`bun run migrate`)
 */

import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import postgres, { type Sql } from 'postgres';
import { createApp } from '../../src/index';
import type { Env } from '../../src/env';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://seedkeep:dev-only@localhost:5432/seedkeep';

const sql: Sql = postgres(DATABASE_URL, {
  transform: { undefined: null },
  onnotice: () => { /* silence */ },
});

mock.module('../../src/lib/storage', () => ({
  deletePhoto: async () => {},
  putPhoto: async () => {},
  getPhoto: async () => null,
  newPhotoKey: () => 'mocked-key',
  isAllowedMime: () => true,
}));

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
  ASSISTANT_KEY_MASTER: Buffer.from('test-master-key-household-lookup-1').toString('base64'),
  DEFAULT_VISION_MODEL: 'claude-sonnet-4-6',
  DEFAULT_REVIEW_MODEL: 'claude-haiku-4-5-20251001',
  ADMIN_SECRET: 'test-admin-secret-please',
  GARDEN_TOOLS_ENABLED: true,
};

const app = createApp(TEST_ENV);

interface OkBody {
  ok: true;
  data: { household: { id: string; name: string }; role: string };
}
interface ErrBody {
  ok: false;
  error: { code: string; message: string };
}
type AnyBody = OkBody | ErrBody;

async function api(
  path: string,
  opts: { token?: string } = {},
): Promise<{ status: number; body: AnyBody }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await app.request(path, { method: 'GET', headers }, TEST_ENV);
  const body = (await res.json()) as AnyBody;
  return { status: res.status, body };
}

function uid(prefix: string): string {
  return `hhl-${prefix}-${Math.random().toString(36).slice(2, 12)}`;
}

async function seedUser(): Promise<{ userId: string; sessionToken: string }> {
  const userId = uid('user');
  const sessionId = uid('sess');
  const sessionToken = uid('tok');
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'Household Lookup User', $2, TRUE,
             to_timestamp($3 / 1000.0), to_timestamp($3 / 1000.0))`,
    [userId, `${userId}@example.invalid`, now],
  );
  await sql.unsafe(
    `INSERT INTO session (id, "expiresAt", token, "createdAt", "updatedAt",
                          "ipAddress", "userAgent", "userId")
     VALUES ($1, NOW() + INTERVAL '1 day', $2, NOW(), NOW(), NULL, NULL, $3)`,
    [sessionId, sessionToken, userId],
  );
  return { userId, sessionToken };
}

async function seedHousehold(name: string): Promise<string> {
  const householdId = uid('hh');
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO households (id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)`,
    [householdId, name, now],
  );
  return householdId;
}

async function addMembership(
  householdId: string,
  userId: string,
  role: 'owner' | 'member',
  joinedAtOffset = 0,
): Promise<void> {
  await sql.unsafe(
    `INSERT INTO memberships (household_id, user_id, role, joined_at)
     VALUES ($1, $2, $3, $4)`,
    [householdId, userId, role, Date.now() + joinedAtOffset],
  );
}

afterAll(async () => {
  await sql.end();
});

describe('GET /api/households/:id', () => {

  it('returns the exact household even when the user has a second, more recent membership', async () => {
    // Mirrors the handoff shape: the user's own long-standing household,
    // then a SECOND membership added later (as the re-home does) for a
    // household `requireHousehold`'s "most recently joined" heuristic
    // would now treat as current.
    const user = await seedUser();
    const ownHouseholdId = await seedHousehold('Own household');
    const transferredHouseholdId = await seedHousehold('Transferred household');
    await addMembership(ownHouseholdId, user.userId, 'owner', 0);
    await addMembership(transferredHouseholdId, user.userId, 'owner', 5000);

    const older = await api(`/api/households/${ownHouseholdId}`, { token: user.sessionToken });
    expect(older.status).toBe(200);
    expect(older.body.ok && older.body.data.household.id).toBe(ownHouseholdId);

    const newer = await api(`/api/households/${transferredHouseholdId}`,
      { token: user.sessionToken });
    expect(newer.status).toBe(200);
    expect(newer.body.ok && newer.body.data.household.id).toBe(transferredHouseholdId);
  });

  it('reports the caller\'s actual role in that specific household', async () => {
    const user = await seedUser();
    const householdId = await seedHousehold('Member household');
    await addMembership(householdId, user.userId, 'member', 0);

    const res = await api(`/api/households/${householdId}`, { token: user.sessionToken });
    expect(res.status).toBe(200);
    expect(res.body.ok && res.body.data.role).toBe('member');
  });

  it('refuses a household this user has no membership row for', async () => {
    const user = await seedUser();
    const otherHouseholdId = await seedHousehold('Someone else\'s household');

    const res = await api(`/api/households/${otherHouseholdId}`, { token: user.sessionToken });
    expect(res.status).toBe(403);
    expect(!res.body.ok && res.body.error.code).toBe('not_a_member');
  });

  it('answers identically for a household id that does not exist at all', async () => {
    // 403, not 404, either way — an authenticated caller must not be able
    // to use this route to enumerate which household ids exist.
    const user = await seedUser();

    const res = await api('/api/households/does-not-exist', { token: user.sessionToken });
    expect(res.status).toBe(403);
    expect(!res.body.ok && res.body.error.code).toBe('not_a_member');
  });

  it('refuses an unauthenticated request before any membership check', async () => {
    const householdId = await seedHousehold('Irrelevant household');
    const res = await api(`/api/households/${householdId}`);
    expect(res.status).toBe(401);
  });

  it('does not shadow or get shadowed by /households/me', async () => {
    const user = await seedUser();
    const householdId = await seedHousehold('Own household');
    await addMembership(householdId, user.userId, 'owner', 0);

    const me = await api('/api/households/me', { token: user.sessionToken });
    expect(me.status).toBe(200);
    expect(me.body.ok && me.body.data.household.id).toBe(householdId);

    const exact = await api(`/api/households/${householdId}`, { token: user.sessionToken });
    expect(exact.status).toBe(200);
    expect(exact.body.ok && exact.body.data.household.id).toBe(householdId);
  });
});

describe('POST /api/households resolves the CURRENT (most recent) membership', () => {
  it('returns the most-recently-joined household, not an arbitrary one, for a user with two', async () => {
    // Mirrors the account-deletion handoff: a successor's own long-
    // standing household, then a second membership the transfer's
    // re-home adds later. `POST /api/households` — called on every
    // `loadIdentity()` — must resolve to the SAME household
    // `requireHousehold` would, or an ordinary session restore right
    // after a successful cutover could re-resolve to the OLD household
    // and, worse, could resolve to it every time since Postgres gives no
    // ordering guarantee without an ORDER BY.
    const user = await seedUser();
    const olderHouseholdId = await seedHousehold('Older household');
    const newerHouseholdId = await seedHousehold('Newer (re-homed) household');
    await addMembership(olderHouseholdId, user.userId, 'owner', 0);
    await addMembership(newerHouseholdId, user.userId, 'owner', 10_000);

    const res = await app.request(
      '/api/households',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
      TEST_ENV,
    );
    const body = (await res.json()) as OkBody;
    expect(res.status).toBe(200);
    expect(body.ok && body.data.household.id).toBe(newerHouseholdId);
  });
});
