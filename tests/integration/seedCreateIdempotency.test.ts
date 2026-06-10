/**
 * Stabilization B3 · integration tests for POST /api/seeds idempotency.
 *
 * The iOS sync engine pushes offline creates with a client-supplied id
 * (`seed_local_<uuid>`) and retries the same payload when a response is
 * lost. These tests lock the contract:
 *
 *   - Replay: the same id POSTed twice yields ONE row; the second
 *     response is a 200 with the same shape as a fresh create.
 *   - Atomicity: a tag FK failure rolls back the seed INSERT too, so the
 *     'invalid_reference' retry advice works — the retry succeeds (no
 *     23505 → 500) and the tags end up attached.
 *   - Cross-household: an id owned by another household is NOT replayed;
 *     the caller gets a 409 and no row.
 *
 * Mirrors the scaffolding in `correctionRoutes.test.ts`: local Postgres,
 * minimal user → session → household → membership chain, requests driven
 * through the Hono app.
 *
 * Run with:
 *
 *   bun test tests/integration/seedCreateIdempotency.test.ts
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

interface Fixture {
  userId: string;
  householdId: string;
  sessionToken: string;
}

async function seedAuthFixture(): Promise<Fixture> {
  const userId = uid('si-user');
  const householdId = uid('si-hh');
  const sessionId = uid('si-sess');
  const sessionToken = uid('si-tok');
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

async function insertTag(householdId: string, id: string): Promise<void> {
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO tags (id, household_id, name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4)`,
    [id, householdId, `Tag ${id.slice(-6)}`, now],
  );
}

interface SeedWire {
  id: string;
  household_id: string;
  catalog_id: string | null;
  state: string;
  packet_count: number;
  location_id: string | null;
  year_packed: number | null;
  source: string;
  custom_name: string | null;
  custom_variety: string | null;
  custom_company: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  tag_ids: string[];
}

interface SeedEnvelope {
  ok: boolean;
  data?: { seed: SeedWire };
  error?: { code: string; message: string };
}

async function postSeed(
  app: ReturnType<typeof createApp>,
  fx: Fixture,
  body: Record<string, unknown>,
): Promise<{ status: number; json: SeedEnvelope }> {
  const res = await app.request(
    '/api/seeds',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${fx.sessionToken}`,
      },
      body: JSON.stringify(body),
    },
    TEST_ENV,
  );
  return { status: res.status, json: (await res.json()) as SeedEnvelope };
}

async function seedRowCount(id: string): Promise<number> {
  const rows = await sql.unsafe<{ n: number }[]>(
    `SELECT COUNT(*)::int AS n FROM seeds WHERE id = $1`,
    [id],
  );
  return rows[0]!.n;
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

describe('POST /api/seeds — replay on retry', () => {
  it('same client id POSTed twice → one row, second response is a 200 replay', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const id = `seed_local_${uid('replay')}`;
    const body = { id, state: 'active', custom_name: 'Cherokee Purple' };

    const first = await postSeed(app, fx, body);
    expect(first.status).toBe(200);
    expect(first.json.ok).toBe(true);
    expect(first.json.data!.seed.id).toBe(id);

    const second = await postSeed(app, fx, body);
    expect(second.status).toBe(200);
    expect(second.json.ok).toBe(true);
    expect(second.json.data!.seed.id).toBe(id);
    expect(second.json.data!.seed.household_id).toBe(fx.householdId);
    expect(second.json.data!.seed.custom_name).toBe('Cherokee Purple');
    // Replay returns the committed row, not a fresh insert.
    expect(second.json.data!.seed.created_at).toBe(first.json.data!.seed.created_at);
    expect(second.json.data!.seed.tag_ids).toEqual([]);

    expect(await seedRowCount(id)).toBe(1);
  });

  it('replay of a create with tags carries the committed tag_ids', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const tagId = `tag_local_${uid('rt')}`;
    await insertTag(fx.householdId, tagId);
    const id = `seed_local_${uid('rtags')}`;
    const body = { id, state: 'active', tag_ids: [tagId] };

    const first = await postSeed(app, fx, body);
    expect(first.status).toBe(200);
    expect(first.json.data!.seed.tag_ids).toEqual([tagId]);

    const second = await postSeed(app, fx, body);
    expect(second.status).toBe(200);
    expect(second.json.ok).toBe(true);
    expect(second.json.data!.seed.tag_ids).toEqual([tagId]);

    expect(await seedRowCount(id)).toBe(1);
    const tagRows = await sql.unsafe<{ n: number }[]>(
      `SELECT COUNT(*)::int AS n FROM seed_tags WHERE seed_id = $1`,
      [id],
    );
    expect(tagRows[0]!.n).toBe(1);
  });
});

describe('POST /api/seeds — tag FK failure then retry', () => {
  it('FK failure rolls back the seed insert; retry after the tag exists succeeds with tags attached', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const tagId = `tag_local_${uid('fk')}`;
    const id = `seed_local_${uid('fkseed')}`;
    const body = { id, state: 'wishlist', tag_ids: [tagId] };

    // Tag hasn't synced yet → FK violation → 400 invalid_reference, and
    // crucially the seed row must NOT be left behind.
    const first = await postSeed(app, fx, body);
    expect(first.status).toBe(400);
    expect(first.json.ok).toBe(false);
    expect(first.json.error!.code).toBe('invalid_reference');
    expect(await seedRowCount(id)).toBe(0);

    // Parent tag syncs, then the queued seed write retries — must be a
    // clean 200 (not a 23505 → 500) with the tag attached.
    await insertTag(fx.householdId, tagId);
    const retry = await postSeed(app, fx, body);
    expect(retry.status).toBe(200);
    expect(retry.json.ok).toBe(true);
    expect(retry.json.data!.seed.id).toBe(id);
    expect(retry.json.data!.seed.tag_ids).toEqual([tagId]);

    expect(await seedRowCount(id)).toBe(1);
    const tagRows = await sql.unsafe<{ n: number }[]>(
      `SELECT COUNT(*)::int AS n FROM seed_tags WHERE seed_id = $1 AND tag_id = $2`,
      [id, tagId],
    );
    expect(tagRows[0]!.n).toBe(1);
  });
});

describe('POST /api/seeds — cross-household id conflict', () => {
  it("does not replay another household's row; returns 409 and inserts nothing", async () => {
    const fxA = await seedAuthFixture();
    const fxB = await seedAuthFixture();
    const app = createApp(TEST_ENV);
    const id = `seed_local_${uid('xhh')}`;

    const first = await postSeed(app, fxA, { id, state: 'active' });
    expect(first.status).toBe(200);

    const second = await postSeed(app, fxB, { id, state: 'active' });
    expect(second.status).toBe(409);
    expect(second.json.ok).toBe(false);
    expect(second.json.error!.code).toBe('conflict');

    // Only household A's row exists.
    const rows = await sql.unsafe<{ household_id: string }[]>(
      `SELECT household_id FROM seeds WHERE id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.household_id).toBe(fxA.householdId);
  });
});
