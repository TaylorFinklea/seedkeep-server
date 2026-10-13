/**
 * `GET /api/households/me` includes the stored home location (web M1 Phase 4:
 * the web client needs ZIP, zone, frost averages and coordinates).
 *
 * Setup helpers mirror householdExactLookup.test.ts. Original context of
 * that file: the exact-household lookup the account-deletion handoff needs.
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
 *   bun test tests/integration/householdLocation.test.ts
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
  data: { household: { id: string; name: string; location: null | { zip: string; latitude: number | null; longitude: number | null; usdaZone: string | null; avgLastFrost: string | null; avgFirstFrost: string | null } } };
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
  return `hhloc-${prefix}-${Math.random().toString(36).slice(2, 12)}`;
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

describe('GET /api/households/me location', () => {
  it('is null before a home ZIP is set', async () => {
    const user = await seedUser();
    const householdId = await seedHousehold('No location yet');
    await addMembership(householdId, user.userId, 'owner');
    const res = await api('/api/households/me', { token: user.sessionToken });
    expect(res.status).toBe(200);
    if (!res.body.ok) throw new Error('expected ok');
    expect(res.body.data.household.id).toBe(householdId);
    expect(res.body.data.household.location).toBeNull();
  });

  it('returns the stored ZIP, zone, frost averages and numeric coordinates', async () => {
    const user = await seedUser();
    const householdId = await seedHousehold('Kansas City');
    await addMembership(householdId, user.userId, 'owner');
    await sql.unsafe(
      `UPDATE households SET home_zip = '64110', latitude = 39.03443, longitude = -94.57265,
              usda_zone = '6b', avg_last_frost = '04-12', avg_first_frost = '10-21'
        WHERE id = $1`,
      [householdId],
    );
    const res = await api('/api/households/me', { token: user.sessionToken });
    expect(res.status).toBe(200);
    if (!res.body.ok) throw new Error('expected ok');
    expect(res.body.data.household.location).toEqual({
      zip: '64110',
      latitude: 39.03443,
      longitude: -94.57265,
      usdaZone: '6b',
      avgLastFrost: '04-12',
      avgFirstFrost: '10-21',
    });
  });
});
