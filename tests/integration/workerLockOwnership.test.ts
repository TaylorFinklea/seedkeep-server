/**
 * Security fix [11] — Worker lock ownership fencing.
 *
 * Asserts that a stale (reaped) claim cannot clobber a row that has been
 * re-claimed by a newer tick. The test simulates a tick that was reaped
 * (ai_locked_at cleared by the reaper) while the original tick is still
 * running, then verifies processOne with the newer tick wins.
 *
 * Also covers fix [9]: sweepAuditLog must not delete manual_revert rows.
 *
 * Run with:
 *   bun test tests/integration/workerLockOwnership.test.ts
 *
 * Prerequisites:
 *   - Local Postgres reachable at DATABASE_URL
 *   - Migrations applied (`bun run migrate`)
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import postgres, { type Sql } from 'postgres';
import { nanoid } from 'nanoid';
import { randomBytes } from 'node:crypto';
import type { Env } from '../../src/env';
import {
  applyCorrectionOutcome,
  sweepAuditLog,
  AUDIT_LOG_RETENTION_MS,
  ZombieGuardError,
} from '../../src/lib/catalog/moderationWorker';
import type { ClaimedCorrection } from '../../src/lib/catalog/moderationWorker';
import type { AiReviewResult } from '../../src/lib/catalog/aiReview';

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
    numeric: {
      to: 1700,
      from: [1700],
      serialize: (x: number) => String(x),
      parse: (x: string) => Number(x),
    },
  },
});

const TEST_MASTER_KEY = randomBytes(32).toString('base64');

// TEST_ENV is referenced for type-compat only; not actually used here.
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
  ANTHROPIC_API_KEY: 'test-key',
  APPLE_IAP_SHARED_SECRET: undefined,
  ASSISTANT_KEY_MASTER: TEST_MASTER_KEY,
  DEFAULT_VISION_MODEL: 'claude-sonnet-4-6',
  DEFAULT_REVIEW_MODEL: 'claude-haiku-4-5-20251001',
  ADMIN_SECRET: 'test-admin-secret',
};
void TEST_ENV;

const cleanup = {
  userIds: new Set<string>(),
  householdIds: new Set<string>(),
  catalogIds: new Set<string>(),
  correctionIds: new Set<string>(),
  auditIds: new Set<string>(),
};

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 12)}`;
}

async function seedAuthFixture(): Promise<{ userId: string; householdId: string }> {
  const userId = uid('wlo-user');
  const householdId = uid('wlo-hh');
  const now = Date.now();

  await sql.unsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'WLO User', $2, TRUE,
             to_timestamp($3 / 1000.0), to_timestamp($3 / 1000.0))`,
    [userId, `${userId}@example.invalid`, now],
  );
  cleanup.userIds.add(userId);

  await sql.unsafe(
    `INSERT INTO households (id, name, created_at, updated_at)
     VALUES ($1, 'WLO Household', $2, $2)`,
    [householdId, now],
  );
  cleanup.householdIds.add(householdId);

  await sql.unsafe(
    `INSERT INTO memberships (household_id, user_id, role, joined_at)
     VALUES ($1, $2, 'owner', $3)`,
    [householdId, userId, now],
  );

  return { userId, householdId };
}

async function seedCatalog(): Promise<string> {
  const id = uid('wlo-cat');
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO catalog_seeds
       (id, common_name, days_to_maturity_min, days_to_maturity_max,
        status, created_at, updated_at, published_at)
     VALUES ($1, 'Tomato', 60, 80, 'published', $2::BIGINT, $2::BIGINT, $2::BIGINT)`,
    [id, now],
  );
  cleanup.catalogIds.add(id);
  return id;
}

async function seedOpenCorrection(
  userId: string,
  householdId: string,
  catalogId: string,
  lockedAt: number | null = null,
): Promise<string> {
  const id = `cf_${nanoid(12)}`;
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO catalog_feedback
       (id, catalog_seed_id, household_id, user_id, body, field_name,
        suggested_value, client_seen_value, value_type, catalog_seed_name,
        user_acknowledged_bounds, status, created_at, updated_at, ai_locked_at)
     VALUES ($1, $2, $3, $4, 'body', 'days_to_maturity_min', '65', '60',
             'integer', 'Tomato', FALSE, 'open', $5::BIGINT, $5::BIGINT, $6)`,
    [id, catalogId, householdId, userId, now, lockedAt],
  );
  cleanup.correctionIds.add(id);
  return id;
}

beforeAll(async () => {
  await sql`SELECT 1`;
});

beforeEach(async () => {
  // Clear open rows to prevent cross-test interference.
  await sql.unsafe(`DELETE FROM catalog_feedback WHERE status = 'open'`);
});

afterAll(async () => {
  for (const id of cleanup.auditIds) {
    await sql.unsafe(`DELETE FROM catalog_audit_log WHERE id = $1`, [id]).catch(() => {});
  }
  for (const id of cleanup.correctionIds) {
    await sql.unsafe(`DELETE FROM catalog_audit_log WHERE correction_id = $1`, [id]).catch(() => {});
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

describe('Worker lock ownership fencing [11]', () => {
  it('stale claim (wrong claimTs) cannot clobber a row re-claimed by a newer tick', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();

    // Stale tick's claim timestamp.
    const staleClaimTs = Date.now() - 5_000;
    const id = await seedOpenCorrection(fx.userId, fx.householdId, catalogId, staleClaimTs);

    // Reaper fires — clears ai_locked_at (simulated by setting to NULL).
    await sql.unsafe(
      `UPDATE catalog_feedback SET ai_locked_at = NULL WHERE id = $1`,
      [id],
    );

    // Newer tick re-claims the row with a fresh timestamp.
    const freshClaimTs = Date.now();
    await sql.unsafe(
      `UPDATE catalog_feedback SET ai_locked_at = $1 WHERE id = $2`,
      [freshClaimTs, id],
    );

    // Stale tick now tries to apply using its old claimTs — must be a no-op.
    const staleRow: ClaimedCorrection = {
      id,
      catalog_seed_id: catalogId,
      household_id: fx.householdId,
      user_id: fx.userId,
      field_name: 'days_to_maturity_min',
      suggested_value: '65',
      client_seen_value: '60',
      ai_attempts: 0,
      ai_review_score: 0.95,
      ai_self_confidence: 0.9,
      ai_notes: null,
      ai_raw_response: null,
      user_acknowledged_bounds: false,
      idempotency_key: null,
    };

    const aiMeta: AiReviewResult = {
      ok: true,
      reviewScore: 0.95,
      selfConfidence: 0.9,
      normalizedValue: 65,
      notes: '',
      raw: {},
    };

    // Apply with stale claimTs — the AND ai_locked_at = $staleClaimTs clause
    // must not match the row (which now has freshClaimTs) so the stale
    // apply is a no-op.
    try {
      await applyCorrectionOutcome(
        sql,
        staleRow,
        { action: 'auto_apply', normalizedValue: 65, reason: 'auto_apply' },
        aiMeta,
        Date.now(),
        staleClaimTs,
      );
    } catch (err) {
      // Only swallow ZombieGuardError — the lock clause firing is expected.
      // Any other error (DB failure, etc.) is re-thrown to surface the real cause.
      if (!(err instanceof ZombieGuardError)) throw err;
    }

    // Catalog value must NOT have been changed by the stale apply.
    const cat = await sql.unsafe<{ days_to_maturity_min: number | null }[]>(
      `SELECT days_to_maturity_min FROM catalog_seeds WHERE id = $1`,
      [catalogId],
    );
    expect(cat[0]?.days_to_maturity_min).toBe(60);

    // The row must still be open and held by the fresh tick's lock.
    const fb = await sql.unsafe<{ status: string; ai_locked_at: number | null }[]>(
      `SELECT status, ai_locked_at FROM catalog_feedback WHERE id = $1`,
      [id],
    );
    expect(fb[0]?.status).toBe('open');
    expect(fb[0]?.ai_locked_at).toBe(freshClaimTs);
  });

  it('correct claimTs allows the apply to succeed', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();

    const claimTs = Date.now();
    const id = await seedOpenCorrection(fx.userId, fx.householdId, catalogId, claimTs);

    const row: ClaimedCorrection = {
      id,
      catalog_seed_id: catalogId,
      household_id: fx.householdId,
      user_id: fx.userId,
      field_name: 'days_to_maturity_min',
      suggested_value: '65',
      client_seen_value: '60',
      ai_attempts: 0,
      ai_review_score: 0.95,
      ai_self_confidence: 0.9,
      ai_notes: null,
      ai_raw_response: null,
      user_acknowledged_bounds: false,
      idempotency_key: null,
    };

    const aiMeta: AiReviewResult = {
      ok: true,
      reviewScore: 0.95,
      selfConfidence: 0.9,
      normalizedValue: 65,
      notes: '',
      raw: {},
    };

    // Apply with the correct claimTs — must succeed.
    await applyCorrectionOutcome(
      sql,
      row,
      { action: 'auto_apply', normalizedValue: 65, reason: 'auto_apply' },
      aiMeta,
      Date.now(),
      claimTs,
    );

    const cat = await sql.unsafe<{ days_to_maturity_min: number | null }[]>(
      `SELECT days_to_maturity_min FROM catalog_seeds WHERE id = $1`,
      [catalogId],
    );
    expect(cat[0]?.days_to_maturity_min).toBe(65);

    const fb = await sql.unsafe<{ status: string }[]>(
      `SELECT status FROM catalog_feedback WHERE id = $1`,
      [id],
    );
    expect(fb[0]?.status).toBe('applied');
  });
});

describe('sweepAuditLog — manual_revert excluded from sweep [9]', () => {
  it('manual_revert rows are NOT deleted even when older than retention window', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();

    const old = Date.now() - AUDIT_LOG_RETENTION_MS - 86_400_000;
    const autoApplyId = `cal_${nanoid(12)}`;
    const manualRevertId = `cal_${nanoid(12)}`;

    // Insert an old auto_apply row (should be swept).
    await sql.unsafe(
      `INSERT INTO catalog_audit_log
         (id, catalog_seed_id, field_name, old_value, new_value, source,
          correction_id, actor_user_id, created_at)
       VALUES ($1, $2, 'days_to_maturity_min', '60', '65', 'auto_apply',
               NULL, NULL, $3)`,
      [autoApplyId, catalogId, old],
    );
    cleanup.auditIds.add(autoApplyId);

    // Insert an old manual_revert row (must NOT be swept).
    await sql.unsafe(
      `INSERT INTO catalog_audit_log
         (id, catalog_seed_id, field_name, old_value, new_value, source,
          correction_id, actor_user_id, created_at)
       VALUES ($1, $2, 'days_to_maturity_min', '65', '60', 'manual_revert',
               NULL, NULL, $3)`,
      [manualRevertId, catalogId, old],
    );
    cleanup.auditIds.add(manualRevertId);

    await sweepAuditLog(sql);

    const remaining = await sql.unsafe<{ id: string; source: string }[]>(
      `SELECT id, source FROM catalog_audit_log WHERE id IN ($1, $2)`,
      [autoApplyId, manualRevertId],
    );

    const remainingIds = remaining.map((r) => r.id);
    expect(remainingIds).not.toContain(autoApplyId);
    expect(remainingIds).toContain(manualRevertId);
    expect(remaining.find((r) => r.id === manualRevertId)?.source).toBe('manual_revert');
  });
});
