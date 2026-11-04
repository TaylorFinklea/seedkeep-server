import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createApp } from '../../index';
import type { Env } from '../../env';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://seedkeep:dev-only@localhost:5432/seedkeep';
const databaseHost = new URL(DATABASE_URL).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(databaseHost)) {
  throw new Error('Household location integration tests require a loopback PostgreSQL database');
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

const app = createApp(env);
const ids = {
  user: `location-user-${crypto.randomUUID()}`,
  session: `location-session-${crypto.randomUUID()}`,
  token: `location-token-${crypto.randomUUID()}`,
  older: `location-garden-${crypto.randomUUID()}`,
  newer: `location-garden-${crypto.randomUUID()}`,
  otherUser: `location-user-${crypto.randomUUID()}`,
  otherSession: `location-session-${crypto.randomUUID()}`,
  otherToken: `location-token-${crypto.randomUUID()}`,
  foreign: `location-garden-${crypto.randomUUID()}`,
};
const testZip = String(90000 + Math.floor(Math.random() * 9999));
let ownsZipFixture = false;

async function insertUser(userId: string, sessionId: string, token: string) {
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'Location Test', $2, TRUE, $3, $3)`,
    [userId, `${userId}@example.invalid`, new Date(now)],
  );
  await sql.unsafe(
    `INSERT INTO session (id, "expiresAt", token, "createdAt", "updatedAt", "ipAddress", "userAgent", "userId")
     VALUES ($1, NOW() + INTERVAL '1 day', $2, NOW(), NOW(), NULL, NULL, $3)`,
    [sessionId, token, userId],
  );
}

async function insertHousehold(householdId: string, userId: string, name: string, joinedAt: number) {
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO households (id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)`,
    [householdId, name, now],
  );
  await sql.unsafe(
    `INSERT INTO memberships (household_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)`,
    [householdId, userId, joinedAt],
  );
}

describe('household location readback', () => {
  beforeAll(async () => {
    const zipInsert = await sql.unsafe(
      `INSERT INTO zip_locations (zip, latitude, longitude, usda_zone, avg_last_frost, avg_first_frost)
       VALUES ($1, 38.95, -94.80, '6b', '04-15', '10-15') ON CONFLICT (zip) DO NOTHING`,
      [testZip],
    );
    ownsZipFixture = zipInsert.count > 0;
    await insertUser(ids.user, ids.session, ids.token);
    await insertUser(ids.otherUser, ids.otherSession, ids.otherToken);
    await insertHousehold(ids.older, ids.user, 'Older Garden', 100);
    await insertHousehold(ids.newer, ids.user, 'Newer Garden', 200);
    await insertHousehold(ids.foreign, ids.otherUser, 'Foreign Garden', 300);
  });

  afterAll(async () => {
    await sql`DELETE FROM memberships WHERE household_id = ANY(${[ids.older, ids.newer, ids.foreign]})`;
    await sql`DELETE FROM households WHERE id = ANY(${[ids.older, ids.newer, ids.foreign]})`;
    await sql`DELETE FROM session WHERE id = ANY(${[ids.session, ids.otherSession]})`;
    await sql`DELETE FROM "user" WHERE id = ANY(${[ids.user, ids.otherUser]})`;
    if (ownsZipFixture) await sql`DELETE FROM zip_locations WHERE zip = ${testZip}`;
    await sql.end();
  });

  it('reads a saved ZIP after reload and returns null when the default household has none', async () => {
    const selectedHeaders = { Authorization: `Bearer ${ids.token}`, 'X-Household-Id': ids.older };
    const put = await app.request('/api/households/me/location', {
      method: 'PUT',
      headers: { ...selectedHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ zip: testZip }),
    }, env);
    expect(put.status).toBe(200);
    const saved = await put.json() as any;

    const selectedRead = await app.request('/api/households/me', { headers: selectedHeaders }, env);
    expect(selectedRead.status).toBe(200);
    const selected = (await selectedRead.json() as any).data.household;
    expect(selected.location).toMatchObject({
      zip: testZip,
      latitude: saved.data.latitude,
      longitude: saved.data.longitude,
      usdaZone: saved.data.usdaZone,
      avgLastFrost: saved.data.avgLastFrost,
      avgFirstFrost: saved.data.avgFirstFrost,
    });
    expect(selected.location).toHaveProperty('regionId');

    const exactRead = await app.request(`/api/households/${ids.older}`, {
      headers: { Authorization: `Bearer ${ids.token}` },
    }, env);
    expect(exactRead.status).toBe(200);
    expect((await exactRead.json() as any).data.household.location).toEqual(selected.location);

    const defaultRead = await app.request('/api/households/me', {
      headers: { Authorization: `Bearer ${ids.token}` },
    }, env);
    expect(defaultRead.status).toBe(200);
    expect((await defaultRead.json() as any).data.household.location).toBeNull();
  });

  it('does not reveal or return a foreign household location', async () => {
    const response = await app.request(`/api/households/${ids.foreign}`, {
      headers: { Authorization: `Bearer ${ids.token}` },
    }, env);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'not_a_member' } });
  });
});
