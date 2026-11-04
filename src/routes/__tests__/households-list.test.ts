import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createApp } from '../../index';
import type { Env } from '../../env';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://seedkeep:dev-only@localhost:5432/seedkeep';
const databaseHost = new URL(DATABASE_URL).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(databaseHost)) {
  throw new Error('Household list integration tests require a loopback PostgreSQL database');
}

const sql: Sql = postgres(DATABASE_URL, { onnotice: () => {} });
const env: Env = {
  PORT: 8787,
  APP_ENV: 'development',
  DATABASE_URL,
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
  S3_BUCKET: 'test-bucket',
  S3_FORCE_PATH_STYLE: false,
  BETTER_AUTH_SECRET: 'test-better-auth-secret-1234567890',
  ANTHROPIC_API_KEY: undefined,
  APPLE_IAP_SHARED_SECRET: undefined,
  ASSISTANT_KEY_MASTER: undefined,
  DEFAULT_VISION_MODEL: 'claude-sonnet-4-6',
  DEFAULT_REVIEW_MODEL: 'claude-haiku-4-5-20251001',
  ADMIN_SECRET: undefined,
  GARDEN_TOOLS_ENABLED: false,
};

const createdUsers: string[] = [];
const createdHouseholds: string[] = [];

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function seedUser(): Promise<{ userId: string; token: string }> {
  const userId = id('household-list-user');
  const sessionId = id('household-list-session');
  const token = id('household-list-token');
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'Household List Test', $2, TRUE, $3, $3)`,
    [userId, `${userId}@example.invalid`, new Date(now)],
  );
  createdUsers.push(userId);
  await sql.unsafe(
    `INSERT INTO session (id, "expiresAt", token, "createdAt", "updatedAt", "ipAddress", "userAgent", "userId")
     VALUES ($1, NOW() + INTERVAL '1 day', $2, NOW(), NOW(), NULL, NULL, $3)`,
    [sessionId, token, userId],
  );
  return { userId, token };
}

async function seedHousehold(userId: string, name: string, joinedAt: number): Promise<string> {
  const householdId = id('household-list-garden');
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO households (id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)`,
    [householdId, name, now],
  );
  createdHouseholds.push(householdId);
  await sql.unsafe(
    `INSERT INTO memberships (household_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)`,
    [householdId, userId, joinedAt],
  );
  return householdId;
}

describe('GET /api/households', () => {
  beforeAll(async () => {
    await sql`SELECT 1`;
  });

  afterAll(async () => {
    if (createdHouseholds.length) {
      await sql`DELETE FROM memberships WHERE household_id = ANY(${createdHouseholds})`;
      await sql`DELETE FROM households WHERE id = ANY(${createdHouseholds})`;
    }
    if (createdUsers.length) {
      await sql`DELETE FROM session WHERE "userId" = ANY(${createdUsers})`;
      await sql`DELETE FROM "user" WHERE id = ANY(${createdUsers})`;
    }
    await sql.end();
  });

  it('returns an empty list for an authenticated user with no memberships', async () => {
    const user = await seedUser();
    const response = await createApp(env).request('/api/households', {
      headers: { Authorization: `Bearer ${user.token}` },
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, data: { households: [] } });
  });

  it('returns only the caller memberships, newest first, in the web DTO shape', async () => {
    const caller = await seedUser();
    const other = await seedUser();
    const olderId = await seedHousehold(caller.userId, 'Older Garden', 100);
    const newerId = await seedHousehold(caller.userId, 'Newer Garden', 200);
    await seedHousehold(other.userId, 'Private Garden', 300);

    const response = await createApp(env).request('/api/households', {
      headers: {
        Authorization: `Bearer ${caller.token}`,
        'X-Household-Id': id('untrusted-household-header'),
      },
    }, env);

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      data: { households: Array<{ id: string; name: string; role: string; joined_at: number }> };
    };
    expect(body.data.households).toEqual([
      { id: newerId, name: 'Newer Garden', role: 'owner', joined_at: 200 },
      { id: olderId, name: 'Older Garden', role: 'owner', joined_at: 100 },
    ]);
    expect(body.data.households.some((household) => household.name === 'Private Garden')).toBe(false);
  });

  it('uses an explicitly selected membership and keeps newest-first default when absent', async () => {
    const caller = await seedUser();
    const olderId = await seedHousehold(caller.userId, 'Older Garden', 100);
    const newerId = await seedHousehold(caller.userId, 'Newer Garden', 200);
    const app = createApp(env);

    const selected = await app.request('/api/households/me', {
      headers: {
        Authorization: `Bearer ${caller.token}`,
        'X-Household-Id': olderId,
      },
    }, env);
    expect(selected.status).toBe(200);
    expect(((await selected.json()) as { data: { household: { id: string } } }).data.household.id).toBe(olderId);

    const created = await app.request('/api/locations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${caller.token}`,
        'X-Household-Id': olderId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: id('selected-garden-location'), name: 'Selected Garden Location' }),
    }, env);
    expect(created.status).toBe(200);
    const locationId = ((await created.json()) as { data: { location: { id: string } } }).data.location.id;
    const savedLocation = await sql<{ household_id: string }[]>`
      SELECT household_id FROM locations WHERE id = ${locationId}`;
    expect(savedLocation[0].household_id).toBe(olderId);
    const newestLocations = await app.request('/api/locations', {
      headers: { Authorization: `Bearer ${caller.token}` },
    }, env);
    expect(((await newestLocations.json()) as { data: { items: unknown[] } }).data.items).toEqual([]);

    const defaultSelection = await app.request('/api/households/me', {
      headers: { Authorization: `Bearer ${caller.token}` },
    }, env);
    expect(defaultSelection.status).toBe(200);
    expect(((await defaultSelection.json()) as { data: { household: { id: string } } }).data.household.id).toBe(newerId);
  });

  it('rejects a household header owned by another user without revealing it', async () => {
    const caller = await seedUser();
    const other = await seedUser();
    const foreignId = await seedHousehold(other.userId, 'Private Garden', 300);
    const response = await createApp(env).request('/api/households/me', {
      headers: {
        Authorization: `Bearer ${caller.token}`,
        'X-Household-Id': foreignId,
      },
    }, env);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: 'not_a_member', message: 'Not a member of this household.' },
    });
  });

  it('rejects empty and deleted household header values', async () => {
    const caller = await seedUser();
    const deletedId = await seedHousehold(caller.userId, 'Deleted Garden', 300);
    const app = createApp(env);

    await sql`UPDATE households SET deleted_at = ${Date.now()} WHERE id = ${deletedId}`;
    for (const selectedId of ['', deletedId]) {
      const response = await app.request('/api/households/me', {
        headers: {
          Authorization: `Bearer ${caller.token}`,
          'X-Household-Id': selectedId,
        },
      }, env);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: 'not_a_member', message: 'Not a member of this household.' },
      });
    }
  });
});
