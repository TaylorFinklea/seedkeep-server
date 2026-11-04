import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createApp } from '../../index';
import type { Env } from '../../env';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://seedkeep:dev-only@localhost:5432/seedkeep';
const databaseHost = new URL(DATABASE_URL).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(databaseHost)) {
  throw new Error('Seed custom type integration tests require a loopback PostgreSQL database');
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

const fixture = {
  userId: `custom-type-user-${crypto.randomUUID()}`,
  householdId: `custom-type-household-${crypto.randomUUID()}`,
  sessionId: `custom-type-session-${crypto.randomUUID()}`,
  token: `custom-type-token-${crypto.randomUUID()}`,
};
const app = createApp(env);
const authHeaders = { Authorization: `Bearer ${fixture.token}` };
const createdSeedIds = new Set<string>();

async function postSeed(id: string, body: Record<string, unknown>) {
  createdSeedIds.add(id);
  return app.request('/api/seeds', {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, state: 'active', custom_name: 'Test seed', ...body }),
  }, env);
}

describe('seed custom type persistence', () => {
  beforeAll(async () => {
    const now = Date.now();
    await sql.unsafe(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, 'Seed Type Test', $2, TRUE, $3, $3)`,
      [fixture.userId, `${fixture.userId}@example.invalid`, new Date(now)],
    );
    await sql.unsafe(
      `INSERT INTO session (id, "expiresAt", token, "createdAt", "updatedAt", "ipAddress", "userAgent", "userId")
       VALUES ($1, NOW() + INTERVAL '1 day', $2, NOW(), NOW(), NULL, NULL, $3)`,
      [fixture.sessionId, fixture.token, fixture.userId],
    );
    await sql.unsafe(
      `INSERT INTO households (id, name, created_at, updated_at) VALUES ($1, 'Seed Type Garden', $2, $2)`,
      [fixture.householdId, now],
    );
    await sql.unsafe(
      `INSERT INTO memberships (household_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)`,
      [fixture.householdId, fixture.userId, now],
    );
  });

  afterAll(async () => {
    if (createdSeedIds.size) {
      await sql`DELETE FROM seeds WHERE id = ANY(${Array.from(createdSeedIds)})`;
    }
    await sql`DELETE FROM memberships WHERE household_id = ${fixture.householdId}`;
    await sql`DELETE FROM households WHERE id = ${fixture.householdId}`;
    await sql`DELETE FROM session WHERE id = ${fixture.sessionId}`;
    await sql`DELETE FROM "user" WHERE id = ${fixture.userId}`;
    await sql.end();
  });

  it('persists custom_type through create, idempotent replay, list, detail, update, and clear', async () => {
    const seedId = `custom-type-seed-${crypto.randomUUID()}`;
    const created = await postSeed(seedId, { custom_type: '  Tomato  ' });
    expect(created.status).toBe(200);
    expect(((await created.json()) as any).data.seed.custom_type).toBe('Tomato');

    const replay = await postSeed(seedId, { custom_type: 'Pea' });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as any).data.seed.custom_type).toBe('Tomato');

    const listed = await app.request('/api/seeds?since=0', { headers: authHeaders }, env);
    expect(listed.status).toBe(200);
    const listBody = await listed.json() as any;
    expect(listBody.data.items.find((seed: any) => seed.id === seedId).custom_type).toBe('Tomato');

    const detail = await app.request(`/api/seeds/${seedId}`, { headers: authHeaders }, env);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as any).data.seed.custom_type).toBe('Tomato');

    const random = await app.request('/api/seeds/random', { headers: authHeaders }, env);
    expect(random.status).toBe(200);
    expect(((await random.json()) as any).data.seed.custom_type).toBe('Tomato');

    const omitted = await app.request(`/api/seeds/${seedId}`, {
      method: 'PATCH',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'Leave type unchanged' }),
    }, env);
    expect(omitted.status).toBe(200);
    expect(((await omitted.json()) as any).data.seed.custom_type).toBe('Tomato');

    const updated = await app.request(`/api/seeds/${seedId}`, {
      method: 'PATCH',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ custom_type: '  Bean  ' }),
    }, env);
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as any).data.seed.custom_type).toBe('Bean');

    const cleared = await app.request(`/api/seeds/${seedId}`, {
      method: 'PATCH',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ custom_type: null }),
    }, env);
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as any).data.seed.custom_type).toBeNull();
  });

  it('returns null when a create omits custom_type and rejects values over 120 characters', async () => {
    const seedId = `custom-type-seed-${crypto.randomUUID()}`;
    const created = await postSeed(seedId, {});
    expect(created.status).toBe(200);
    expect(((await created.json()) as any).data.seed.custom_type).toBeNull();

    const invalid = await postSeed(`custom-type-seed-${crypto.randomUUID()}`, {
      custom_type: 'T'.repeat(121),
    });
    expect(invalid.status).toBe(400);
  });
});
