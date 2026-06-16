/**
 * Security fix [1] — IAP receipt-binding test.
 *
 * Verifies that a second user submitting the same original_transaction_id
 * receives 409 receipt_bound_to_other_account, while the original owner
 * retains the 'hosted' tier entitlement.
 *
 * Run with:
 *   bun test tests/integration/subscriptionReceiptBinding.test.ts
 *
 * Prerequisites:
 *   - Local Postgres reachable at DATABASE_URL
 *   - Migrations 0001–0024 applied (`bun run migrate`)
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
  types: {
    bigint: {
      to: 20,
      from: [20],
      serialize: (x: number | bigint) => String(x),
      parse: (x: string) => Number(x),
    },
  },
});

// Mock the Apple receipt verifier so we never hit real Apple endpoints.
const ORIG_TXN_ID = `srb-txn-${Math.random().toString(36).slice(2, 10)}`;
const PRODUCT_ID = 'com.example.seedkeep.annual';
// Active receipt — expires 1 year from now.
const EXPIRES_MS = String(Date.now() + 365 * 24 * 60 * 60 * 1000);

mock.module('../../src/lib/appleReceipt', () => ({
  verifyAppleReceipt: async () => ({
    ok: true,
    environment: 'sandbox' as const,
    latestReceiptInfo: [
      {
        product_id: PRODUCT_ID,
        transaction_id: `txn-${Math.random().toString(36).slice(2)}`,
        original_transaction_id: ORIG_TXN_ID,
        expires_date_ms: EXPIRES_MS,
      },
    ],
    raw: {},
  }),
  pickActiveEntry: (entries: Array<{ expires_date_ms: string; original_transaction_id: string; product_id: string; transaction_id: string }>) =>
    entries[0] ?? null,
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
  APPLE_IAP_SHARED_SECRET: 'test-iap-secret',
  ASSISTANT_KEY_MASTER: Buffer.from('test-master-key-for-subscription-test-xyz').toString('base64'),
  DEFAULT_VISION_MODEL: 'claude-sonnet-4-6',
  DEFAULT_REVIEW_MODEL: 'claude-haiku-4-5-20251001',
  ADMIN_SECRET: 'test-admin-secret-please',
};

const cleanup = {
  userIds: new Set<string>(),
};

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 12)}`;
}

interface UserFixture {
  userId: string;
  sessionToken: string;
}

async function seedUser(): Promise<UserFixture> {
  const userId = uid('srb-user');
  const sessionId = uid('srb-sess');
  const sessionToken = uid('srb-tok');
  const now = Date.now();

  await sql.unsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", tier)
     VALUES ($1, 'Sub Test User', $2, TRUE, $3, $3, 'free')`,
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

async function verifyReceipt(
  app: ReturnType<typeof createApp>,
  sessionToken: string,
): Promise<Response> {
  return app.request(
    '/api/subscriptions/verify',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ receipt_data: 'fake-base64-receipt' }),
    },
    TEST_ENV,
  );
}

beforeAll(async () => {
  await sql`SELECT 1`;
});

afterAll(async () => {
  // Delete subscriptions seeded with our test original_transaction_id.
  await sql.unsafe(
    `DELETE FROM subscriptions WHERE original_transaction_id = $1`,
    [ORIG_TXN_ID],
  ).catch(() => {});
  for (const id of cleanup.userIds) {
    await sql.unsafe(`DELETE FROM "user" WHERE id = $1`, [id]).catch(() => {});
  }
  await sql.end({ timeout: 5 });
});

describe('IAP receipt-binding security fix [1]', () => {
  it('first user gets tier=hosted; second user with same receipt gets 409', async () => {
    const user1 = await seedUser();
    const user2 = await seedUser();
    const app = createApp(TEST_ENV);

    // First user claims the receipt.
    const res1 = await verifyReceipt(app, user1.sessionToken);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { ok: boolean; data: { tier: string } };
    expect(body1.ok).toBe(true);
    expect(body1.data.tier).toBe('hosted');

    // Second user submitting the same original_transaction_id must get 409.
    const res2 = await verifyReceipt(app, user2.sessionToken);
    expect(res2.status).toBe(409);
    const body2 = (await res2.json()) as { ok: boolean; error: { code: string } };
    expect(body2.ok).toBe(false);
    expect(body2.error.code).toBe('receipt_bound_to_other_account');

    // Original owner still has hosted tier.
    const u1Row = await sql.unsafe<{ tier: string }[]>(
      `SELECT tier FROM "user" WHERE id = $1`,
      [user1.userId],
    );
    expect(u1Row[0]?.tier).toBe('hosted');

    // Second user remains free.
    const u2Row = await sql.unsafe<{ tier: string }[]>(
      `SELECT tier FROM "user" WHERE id = $1`,
      [user2.userId],
    );
    expect(u2Row[0]?.tier).toBe('free');
  });
});
