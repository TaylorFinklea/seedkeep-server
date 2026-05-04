import { Hono } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { requireAuth } from '../middleware/auth';
import { dbGet, dbRun } from '../db/helpers';
import { getSql } from '../db/client';
import { pickActiveEntry, verifyAppleReceipt } from '../lib/appleReceipt';

export const subscriptionRoutes = new Hono<AppEnv>();

const authOnly = requireAuth();

const verifySchema = z.object({
  // base64-encoded receipt blob from StoreKit 2 on the iOS client.
  receipt_data: z.string().min(1),
});

interface SubscriptionRow {
  id: string;
  user_id: string;
  product_id: string;
  original_transaction_id: string;
  latest_transaction_id: string;
  receipt_data: string;
  status: 'active' | 'expired' | 'cancelled' | 'refunded';
  expires_at: number;
  last_verified_at: number;
  environment: 'production' | 'sandbox';
  created_at: number;
  updated_at: number;
}

/**
 * POST /api/subscriptions/verify
 *
 * Body: `{ "receipt_data": "<base64>" }`.
 *
 * Validates the receipt against Apple, persists the subscription record,
 * and flips `users.tier` to `hosted` while the subscription is active.
 * Re-callable: the iOS client calls this on every app launch and after
 * any in-app purchase / restore.
 */
subscriptionRoutes.post('/subscriptions/verify', authOnly, async (c) => {
  const userId = c.get('userId');
  const sql = getSql(c.env);
  const sharedSecret = c.env.APPLE_IAP_SHARED_SECRET;

  if (!sharedSecret) {
    return c.json(
      { ok: false, error: { code: 'not_configured', message: 'APPLE_IAP_SHARED_SECRET is not configured' } },
      503,
    );
  }

  const body = await c.req.json().catch(() => null);
  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: { code: 'bad_request', message: parsed.error.message } }, 400);
  }

  const verify = await verifyAppleReceipt({
    receiptData: parsed.data.receipt_data,
    sharedSecret,
  });

  if (!verify.ok) {
    return c.json(
      { ok: false, error: { code: 'verification_failed', message: verify.message } },
      400,
    );
  }

  const entry = pickActiveEntry(verify.latestReceiptInfo);
  if (!entry) {
    return c.json(
      { ok: false, error: { code: 'no_subscription', message: 'Receipt contains no subscription entries' } },
      400,
    );
  }

  const expiresAt = Number(entry.expires_date_ms);
  const cancelledAt = entry.cancellation_date_ms ? Number(entry.cancellation_date_ms) : null;
  const status: SubscriptionRow['status'] =
    cancelledAt && cancelledAt <= Date.now() ? 'refunded' :
    expiresAt < Date.now() ? 'expired' :
    'active';

  const now = Date.now();

  // Idempotent insert: if we already have a row keyed by
  // `original_transaction_id`, update it. Otherwise insert.
  const existing = await dbGet<SubscriptionRow>(
    sql,
    `SELECT id, user_id, product_id, original_transaction_id, latest_transaction_id,
            receipt_data, status, expires_at, last_verified_at, environment,
            created_at, updated_at
       FROM subscriptions
      WHERE original_transaction_id = $1
      LIMIT 1`,
    [entry.original_transaction_id],
  );

  if (existing) {
    await dbRun(
      sql,
      `UPDATE subscriptions
          SET product_id = $1,
              latest_transaction_id = $2,
              receipt_data = $3,
              status = $4,
              expires_at = $5,
              last_verified_at = $6,
              environment = $7,
              updated_at = $8
        WHERE id = $9`,
      [
        entry.product_id,
        entry.transaction_id,
        parsed.data.receipt_data,
        status,
        expiresAt,
        now,
        verify.environment,
        now,
        existing.id,
      ],
    );
  } else {
    await dbRun(
      sql,
      `INSERT INTO subscriptions (
        id, user_id, product_id, original_transaction_id, latest_transaction_id,
        receipt_data, status, expires_at, last_verified_at, environment,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        nanoid(), userId, entry.product_id,
        entry.original_transaction_id, entry.transaction_id,
        parsed.data.receipt_data,
        status, expiresAt, now, verify.environment,
        now, now,
      ],
    );
  }

  // Flip the user's tier based on the subscription state. We only
  // promote to hosted on `active`; downgrade to `free` on anything else
  // (don't downgrade BYOK users — they manage their own keys).
  const desiredTier = status === 'active' ? 'hosted' : 'free';
  await dbRun(
    sql,
    `UPDATE "user"
        SET tier = $1, "updatedAt" = $2
      WHERE id = $3
        AND tier <> 'byok'`,
    [desiredTier, now, userId],
  );

  return c.json({
    ok: true,
    data: {
      tier: desiredTier,
      environment: verify.environment,
      subscription: {
        product_id: entry.product_id,
        original_transaction_id: entry.original_transaction_id,
        status,
        expires_at: expiresAt,
      },
    },
  });
});

/**
 * GET /api/subscriptions/me — current subscription state for the
 * authenticated user.
 */
subscriptionRoutes.get('/subscriptions/me', authOnly, async (c) => {
  const userId = c.get('userId');
  const sql = getSql(c.env);
  const subscription = await dbGet<SubscriptionRow>(
    sql,
    `SELECT id, user_id, product_id, original_transaction_id, latest_transaction_id,
            status, expires_at, last_verified_at, environment, created_at, updated_at
       FROM subscriptions
      WHERE user_id = $1
      ORDER BY expires_at DESC
      LIMIT 1`,
    [userId],
  );
  const tier = await dbGet<{ tier: string }>(
    sql,
    `SELECT tier FROM "user" WHERE id = $1 LIMIT 1`,
    [userId],
  );
  return c.json({
    ok: true,
    data: {
      tier: tier?.tier ?? 'free',
      subscription,
    },
  });
});
