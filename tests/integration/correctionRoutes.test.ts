/**
 * Phase 4D · integration tests for the structured-correction routes.
 *
 * Mirrors `tests/integration/watering-state.test.ts`: connects to local
 * Postgres, seeds the minimal user → session → household → membership
 * chain, drives requests through the Hono app, asserts both response
 * shape and persisted state.
 *
 * Run with:
 *
 *   bun test tests/integration/correctionRoutes.test.ts
 *
 * Prerequisites:
 *   - Local Postgres reachable at DATABASE_URL
 *   - Migrations 0001–0021 applied (`bun run migrate`)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
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

async function seedAuthFixture(): Promise<Fixture> {
  const userId = uid('cf-user');
  const householdId = uid('cf-hh');
  const sessionId = uid('cf-sess');
  const sessionToken = uid('cf-tok');
  const now = Date.now();
  // Backdate the user so it's >= 7 days old (passes account_age gate).
  const eightDaysAgo = now - 8 * 86_400_000;

  await sql.unsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'Test User', $2, TRUE,
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

async function seedCatalog(opts: {
  commonName?: string;
  daysToMaturityMin?: number | null;
  daysToMaturityMax?: number | null;
  sun?: 'full' | 'partial' | 'shade' | null;
  status?: 'pending' | 'published' | 'rejected';
} = {}): Promise<string> {
  const id = uid('cf-cat');
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO catalog_seeds
       (id, common_name, days_to_maturity_min, days_to_maturity_max,
        sun_requirement, status, created_at, updated_at, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::BIGINT, $7::BIGINT,
             CASE WHEN $6 = 'published' THEN $7::BIGINT ELSE NULL END)`,
    [
      id,
      opts.commonName ?? 'Tomato',
      opts.daysToMaturityMin ?? 60,
      opts.daysToMaturityMax ?? 80,
      opts.sun ?? 'full',
      opts.status ?? 'published',
      now,
    ],
  );
  cleanup.catalogIds.add(id);
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
    await sql.unsafe(`DELETE FROM catalog_audit_log WHERE catalog_seed_id = $1`, [id]).catch(() => {});
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

beforeEach(() => {
  cleanup.correctionIds.clear();
});

describe('POST /api/catalog/:id/feedback — structured submit', () => {
  it('201 with id + status open on a clean numeric correction', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();
    const app = createApp(TEST_ENV);

    const res = await app.request(
      `/api/catalog/${catalogId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({
          body: 'Cherry tomato range is 65-75 days in my zone.',
          field_name: 'days_to_maturity_min',
          suggested_value: '70',
          client_seen_value: '60',
        }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      ok: boolean;
      data: { id: string; status: string };
    };
    expect(json.ok).toBe(true);
    expect(json.data.id).toMatch(/^cf_/);
    expect(json.data.status).toBe('open');
    cleanup.correctionIds.add(json.data.id);

    const rows = await sql.unsafe<{ status: string; field_name: string | null; suggested_value: string | null }[]>(
      `SELECT status, field_name, suggested_value FROM catalog_feedback WHERE id = $1`,
      [json.data.id],
    );
    expect(rows[0]?.status).toBe('open');
    expect(rows[0]?.field_name).toBe('days_to_maturity_min');
    expect(rows[0]?.suggested_value).toBe('70');
  });

  it('idempotency replay returns 200 with same id and CURRENT status', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();
    const app = createApp(TEST_ENV);
    const idem = uid('idem');

    const first = await app.request(
      `/api/catalog/${catalogId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
          'Idempotency-Key': idem,
        },
        body: JSON.stringify({
          body: 'first time',
          field_name: 'days_to_maturity_min',
          suggested_value: '70',
        }),
      },
      TEST_ENV,
    );
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as { data: { id: string } };
    cleanup.correctionIds.add(firstJson.data.id);

    const second = await app.request(
      `/api/catalog/${catalogId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
          'Idempotency-Key': idem,
        },
        body: JSON.stringify({
          body: 'second time',
          field_name: 'days_to_maturity_min',
          suggested_value: '70',
        }),
      },
      TEST_ENV,
    );
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as {
      data: { id: string; status: string };
      replay: boolean;
    };
    expect(secondJson.replay).toBe(true);
    expect(secondJson.data.id).toBe(firstJson.data.id);
    expect(secondJson.data.status).toBe('open');
  });

  it('duplicate (user, seed, field) open → 409 with existing DTO', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();
    const app = createApp(TEST_ENV);

    const first = await app.request(
      `/api/catalog/${catalogId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({
          body: 'first',
          field_name: 'days_to_maturity_min',
          suggested_value: '70',
        }),
      },
      TEST_ENV,
    );
    const firstJson = (await first.json()) as { data: { id: string } };
    cleanup.correctionIds.add(firstJson.data.id);

    const second = await app.request(
      `/api/catalog/${catalogId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({
          body: 'second',
          field_name: 'days_to_maturity_min',
          suggested_value: '72',
        }),
      },
      TEST_ENV,
    );
    expect(second.status).toBe(409);
    const secondJson = (await second.json()) as {
      error: { code: string };
      existing?: { id: string; status: string };
    };
    expect(secondJson.error.code).toBe('open_correction_exists');
    expect(secondJson.existing?.id).toBe(firstJson.data.id);
  });

  it('bounds violation without ack → 400 with can_file_anyway', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();
    const app = createApp(TEST_ENV);

    const res = await app.request(
      `/api/catalog/${catalogId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({
          body: 'this should fail',
          field_name: 'days_to_maturity_min',
          suggested_value: '999',
        }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as {
      error: { code: string };
      bounds_hint?: string;
      can_file_anyway?: boolean;
    };
    expect(json.error.code).toBe('bounds_violation');
    expect(json.can_file_anyway).toBe(true);
    expect(typeof json.bounds_hint).toBe('string');
  });

  it('bounds violation WITH ack → 201, row flagged', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();
    const app = createApp(TEST_ENV);

    const res = await app.request(
      `/api/catalog/${catalogId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({
          body: 'I know it is out of range',
          field_name: 'days_to_maturity_min',
          suggested_value: '999',
          user_acknowledged_bounds: true,
        }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { id: string } };
    cleanup.correctionIds.add(json.data.id);
    const rows = await sql.unsafe<{ user_acknowledged_bounds: boolean }[]>(
      `SELECT user_acknowledged_bounds FROM catalog_feedback WHERE id = $1`,
      [json.data.id],
    );
    expect(rows[0]?.user_acknowledged_bounds).toBe(true);
  });

  it('field outside CORRECTABLE_FIELDS → 400 bad_request', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();
    const app = createApp(TEST_ENV);

    const res = await app.request(
      `/api/catalog/${catalogId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({
          body: 'try to break',
          field_name: 'barcode',
          suggested_value: '123',
        }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it('unpublished catalog → 404 catalog_entry_not_published', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog({ status: 'pending' });
    const app = createApp(TEST_ENV);

    const res = await app.request(
      `/api/catalog/${catalogId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({
          body: 'noop',
          field_name: 'days_to_maturity_min',
          suggested_value: '70',
        }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('catalog_entry_not_published');
  });

  it('legacy free-form submit (no field_name) still works', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();
    const app = createApp(TEST_ENV);

    const res = await app.request(
      `/api/catalog/${catalogId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({
          body: 'general note about the catalog entry',
          field_hint: 'instructions',
        }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { id: string } };
    cleanup.correctionIds.add(json.data.id);
    const rows = await sql.unsafe<{ field_name: string | null; field_hint: string | null }[]>(
      `SELECT field_name, field_hint FROM catalog_feedback WHERE id = $1`,
      [json.data.id],
    );
    expect(rows[0]?.field_name).toBeNull();
    expect(rows[0]?.field_hint).toBe('instructions');
  });

  it('XSS payload in body → 400 bad_request', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();
    const app = createApp(TEST_ENV);

    const res = await app.request(
      `/api/catalog/${catalogId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({
          body: '<script>alert(1)</script>',
          field_name: 'days_to_maturity_min',
          suggested_value: '70',
        }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/catalog/:id/corrections/:correction_id', () => {
  it('200 when status=open and ai_locked_at IS NULL', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();
    const app = createApp(TEST_ENV);

    const create = await app.request(
      `/api/catalog/${catalogId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({
          body: 'first body',
          field_name: 'days_to_maturity_min',
          suggested_value: '70',
        }),
      },
      TEST_ENV,
    );
    const createJson = (await create.json()) as { data: { id: string } };
    cleanup.correctionIds.add(createJson.data.id);

    const edit = await app.request(
      `/api/catalog/${catalogId}/corrections/${createJson.data.id}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({ suggested_value: '72', body: 'updated body' }),
      },
      TEST_ENV,
    );
    expect(edit.status).toBe(200);
  });

  it('409 when ai_locked_at IS NOT NULL', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();
    const app = createApp(TEST_ENV);

    const create = await app.request(
      `/api/catalog/${catalogId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({
          body: 'body',
          field_name: 'days_to_maturity_min',
          suggested_value: '70',
        }),
      },
      TEST_ENV,
    );
    const id = ((await create.json()) as { data: { id: string } }).data.id;
    cleanup.correctionIds.add(id);

    // Simulate worker claiming the row.
    await sql.unsafe(
      `UPDATE catalog_feedback SET ai_locked_at = $1 WHERE id = $2`,
      [Date.now(), id],
    );

    const edit = await app.request(
      `/api/catalog/${catalogId}/corrections/${id}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({ suggested_value: '72' }),
      },
      TEST_ENV,
    );
    expect(edit.status).toBe(409);
  });
});

describe('DELETE /api/catalog/:id/corrections/:correction_id', () => {
  it('200 flips status to dismissed with reason user_withdrawn', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();
    const app = createApp(TEST_ENV);

    const create = await app.request(
      `/api/catalog/${catalogId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({
          body: 'body',
          field_name: 'days_to_maturity_min',
          suggested_value: '70',
        }),
      },
      TEST_ENV,
    );
    const id = ((await create.json()) as { data: { id: string } }).data.id;
    cleanup.correctionIds.add(id);

    const del = await app.request(
      `/api/catalog/${catalogId}/corrections/${id}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${fx.sessionToken}` },
      },
      TEST_ENV,
    );
    expect(del.status).toBe(200);
    const rows = await sql.unsafe<{ status: string; dismissed_reason: string | null }[]>(
      `SELECT status, dismissed_reason FROM catalog_feedback WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.status).toBe('dismissed');
    expect(rows[0]?.dismissed_reason).toBe('user_withdrawn');
  });

  it('409 when correction is already terminal', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();
    const app = createApp(TEST_ENV);

    const create = await app.request(
      `/api/catalog/${catalogId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({
          body: 'body',
          field_name: 'days_to_maturity_min',
          suggested_value: '70',
        }),
      },
      TEST_ENV,
    );
    const id = ((await create.json()) as { data: { id: string } }).data.id;
    cleanup.correctionIds.add(id);

    await sql.unsafe(
      `UPDATE catalog_feedback SET status = 'applied', applied_at = $1 WHERE id = $2`,
      [Date.now(), id],
    );

    const del = await app.request(
      `/api/catalog/${catalogId}/corrections/${id}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${fx.sessionToken}` },
      },
      TEST_ENV,
    );
    expect(del.status).toBe(409);
  });
});

describe('POST /api/catalog/:id/corrections/:correction_id/escalate', () => {
  it('200 when dismissed reason=ai_low_confidence', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();
    const app = createApp(TEST_ENV);

    const create = await app.request(
      `/api/catalog/${catalogId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({
          body: 'body',
          field_name: 'days_to_maturity_min',
          suggested_value: '70',
        }),
      },
      TEST_ENV,
    );
    const id = ((await create.json()) as { data: { id: string } }).data.id;
    cleanup.correctionIds.add(id);

    await sql.unsafe(
      `UPDATE catalog_feedback
          SET status = 'dismissed', dismissed_reason = 'ai_low_confidence',
              reviewed_at = $1 WHERE id = $2`,
      [Date.now(), id],
    );

    const esc = await app.request(
      `/api/catalog/${catalogId}/corrections/${id}/escalate`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${fx.sessionToken}` },
      },
      TEST_ENV,
    );
    expect(esc.status).toBe(200);
    const rows = await sql.unsafe<{ status: string; dismissed_reason: string | null; escalated_at: number | null }[]>(
      `SELECT status, dismissed_reason, escalated_at FROM catalog_feedback WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.status).toBe('reviewed');
    expect(rows[0]?.dismissed_reason).toBe('user_escalated');
    expect(rows[0]?.escalated_at).not.toBeNull();
  });

  it('409 when dismissed for any other reason', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();
    const app = createApp(TEST_ENV);

    const create = await app.request(
      `/api/catalog/${catalogId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({
          body: 'body',
          field_name: 'days_to_maturity_min',
          suggested_value: '70',
        }),
      },
      TEST_ENV,
    );
    const id = ((await create.json()) as { data: { id: string } }).data.id;
    cleanup.correctionIds.add(id);

    await sql.unsafe(
      `UPDATE catalog_feedback
          SET status = 'dismissed', dismissed_reason = 'user_withdrawn'
        WHERE id = $1`,
      [id],
    );

    const esc = await app.request(
      `/api/catalog/${catalogId}/corrections/${id}/escalate`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${fx.sessionToken}` },
      },
      TEST_ENV,
    );
    expect(esc.status).toBe(409);
  });
});

describe('GET /api/catalog/corrections/mine', () => {
  it('returns rows scoped to the authenticated user only', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();
    const app = createApp(TEST_ENV);

    const create = await app.request(
      `/api/catalog/${catalogId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({
          body: 'mine',
          field_name: 'days_to_maturity_min',
          suggested_value: '70',
        }),
      },
      TEST_ENV,
    );
    const id = ((await create.json()) as { data: { id: string } }).data.id;
    cleanup.correctionIds.add(id);

    const res = await app.request(
      `/api/catalog/corrections/mine?since=0&limit=10`,
      { method: 'GET', headers: { Authorization: `Bearer ${fx.sessionToken}` } },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { items: { id: string }[]; cursor: number; has_more: boolean };
    };
    expect(json.data.items.length).toBeGreaterThanOrEqual(1);
    expect(json.data.items.some((i) => i.id === id)).toBe(true);
  });
});

describe('Notified ledger', () => {
  it('first writer wins; second device GET sees the first device_id', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();
    const app = createApp(TEST_ENV);

    const create = await app.request(
      `/api/catalog/${catalogId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({
          body: 'notify test',
          field_name: 'days_to_maturity_min',
          suggested_value: '70',
        }),
      },
      TEST_ENV,
    );
    const id = ((await create.json()) as { data: { id: string } }).data.id;
    cleanup.correctionIds.add(id);

    const post = await app.request(
      `/api/catalog/corrections/${id}/notified`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({ device_id: 'device-A' }),
      },
      TEST_ENV,
    );
    expect(post.status).toBe(200);

    const get = await app.request(
      `/api/catalog/corrections/${id}/notified`,
      { method: 'GET', headers: { Authorization: `Bearer ${fx.sessionToken}` } },
      TEST_ENV,
    );
    expect(get.status).toBe(200);
    const json = (await get.json()) as { data: { devices: string[] } };
    expect(json.data.devices).toContain('device-A');
  });
});

describe('Admin gate', () => {
  it('GET /admin/corrections without secret → 401', async () => {
    const app = createApp(TEST_ENV);
    const res = await app.request('/admin/corrections', { method: 'GET' }, TEST_ENV);
    expect(res.status).toBe(401);
  });

  it('GET /admin/corrections with wrong secret → 401', async () => {
    const app = createApp(TEST_ENV);
    const res = await app.request(
      '/admin/corrections',
      { method: 'GET', headers: { 'X-Admin-Secret': 'WRONG' } },
      TEST_ENV,
    );
    expect(res.status).toBe(401);
  });

  it('GET /admin/corrections with correct secret → 200 + items array', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();
    const app = createApp(TEST_ENV);

    const create = await app.request(
      `/api/catalog/${catalogId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({
          body: 'reviewable',
          field_name: 'instructions',
          suggested_value: 'Direct sow when soil temp is consistently above 60°F.',
        }),
      },
      TEST_ENV,
    );
    const id = ((await create.json()) as { data: { id: string } }).data.id;
    cleanup.correctionIds.add(id);
    await sql.unsafe(
      `UPDATE catalog_feedback SET status = 'reviewed' WHERE id = $1`,
      [id],
    );

    const res = await app.request(
      '/admin/corrections',
      { method: 'GET', headers: { 'X-Admin-Secret': TEST_ENV.ADMIN_SECRET! } },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { items: { id: string }[] } };
    expect(json.data.items.some((i) => i.id === id)).toBe(true);
  });

  it('POST /admin/corrections/:id/approve mutates catalog + writes audit row', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();
    const app = createApp(TEST_ENV);

    const create = await app.request(
      `/api/catalog/${catalogId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({
          body: 'approve me',
          field_name: 'days_to_maturity_min',
          suggested_value: '65',
          client_seen_value: '60',
        }),
      },
      TEST_ENV,
    );
    const id = ((await create.json()) as { data: { id: string } }).data.id;
    cleanup.correctionIds.add(id);
    await sql.unsafe(
      `UPDATE catalog_feedback SET status = 'reviewed' WHERE id = $1`,
      [id],
    );

    const approve = await app.request(
      `/admin/corrections/${id}/approve`,
      {
        method: 'POST',
        headers: {
          'X-Admin-Secret': TEST_ENV.ADMIN_SECRET!,
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
      TEST_ENV,
    );
    expect(approve.status).toBe(200);

    const seed = await sql.unsafe<{ days_to_maturity_min: number | null }[]>(
      `SELECT days_to_maturity_min FROM catalog_seeds WHERE id = $1`,
      [catalogId],
    );
    expect(seed[0]?.days_to_maturity_min).toBe(65);

    const audit = await sql.unsafe<{ source: string; new_value: string | null }[]>(
      `SELECT source, new_value FROM catalog_audit_log WHERE correction_id = $1`,
      [id],
    );
    expect(audit[0]?.source).toBe('manual_apply');
    expect(audit[0]?.new_value).toBe('65');
  });

  it('admin revert undoes an audit row', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog({ daysToMaturityMin: 60 });
    const app = createApp(TEST_ENV);

    const create = await app.request(
      `/api/catalog/${catalogId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({
          body: 'approve me',
          field_name: 'days_to_maturity_min',
          suggested_value: '65',
          client_seen_value: '60',
        }),
      },
      TEST_ENV,
    );
    const id = ((await create.json()) as { data: { id: string } }).data.id;
    cleanup.correctionIds.add(id);
    await sql.unsafe(
      `UPDATE catalog_feedback SET status = 'reviewed' WHERE id = $1`,
      [id],
    );
    await app.request(
      `/admin/corrections/${id}/approve`,
      {
        method: 'POST',
        headers: {
          'X-Admin-Secret': TEST_ENV.ADMIN_SECRET!,
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
      TEST_ENV,
    );

    const auditRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM catalog_audit_log WHERE correction_id = $1 AND source = 'manual_apply'`,
      [id],
    );
    const auditId = auditRows[0]!.id;

    const revert = await app.request(
      `/api/catalog/${catalogId}/revert/${auditId}`,
      {
        method: 'POST',
        headers: { 'X-Admin-Secret': TEST_ENV.ADMIN_SECRET! },
      },
      TEST_ENV,
    );
    expect(revert.status).toBe(200);

    const seed = await sql.unsafe<{ days_to_maturity_min: number | null }[]>(
      `SELECT days_to_maturity_min FROM catalog_seeds WHERE id = $1`,
      [catalogId],
    );
    expect(seed[0]?.days_to_maturity_min).toBe(60);

    const revertAudit = await sql.unsafe<{ source: string }[]>(
      `SELECT source FROM catalog_audit_log
        WHERE catalog_seed_id = $1 AND source = 'manual_revert'`,
      [catalogId],
    );
    expect(revertAudit.length).toBeGreaterThanOrEqual(1);
  });
});
