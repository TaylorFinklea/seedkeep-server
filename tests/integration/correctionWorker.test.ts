/**
 * Phase 4D · DB-backed worker tests.
 *
 * Exercises the moderation worker end-to-end against a real Postgres,
 * with the AI call mocked via the `review` dependency-injection seam.
 *
 * Run with:
 *
 *   bun test tests/integration/correctionWorker.test.ts
 *
 * Prerequisites:
 *   - Local Postgres reachable at DATABASE_URL
 *   - Migrations 0001–0021 applied (`bun run migrate`)
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import postgres, { type Sql } from 'postgres';
import { randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Env } from '../../src/env';
import {
  processOne,
  applyCorrectionOutcome,
  outcomeStatus,
  reapOrphanedClaims,
  sweepAuditLog,
  REAPER_TIMEOUT_MS,
  AUDIT_LOG_RETENTION_MS,
} from '../../src/lib/catalog/moderationWorker';
import type { AiReviewResult, ReviewCorrectionArgs } from '../../src/lib/catalog/aiReview';
import type { ClaimedCorrection } from '../../src/lib/catalog/moderationWorker';

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
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  APPLE_IAP_SHARED_SECRET: undefined,
  ASSISTANT_KEY_MASTER: TEST_MASTER_KEY,
  DEFAULT_VISION_MODEL: 'claude-sonnet-4-6',
  DEFAULT_REVIEW_MODEL: 'claude-haiku-4-5-20251001',
  ADMIN_SECRET: 'test-admin-secret',
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
}

async function seedAuthFixture(opts: { accountAgeDays?: number } = {}): Promise<Fixture> {
  const userId = uid('cw-user');
  const householdId = uid('cw-hh');
  const now = Date.now();
  const createdMs = now - (opts.accountAgeDays ?? 30) * 86_400_000;

  await sql.unsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'Worker Test', $2, TRUE,
             to_timestamp($3 / 1000.0), to_timestamp($3 / 1000.0))`,
    [userId, `${userId}@example.invalid`, createdMs],
  );
  cleanup.userIds.add(userId);

  await sql.unsafe(
    `INSERT INTO households (id, name, created_at, updated_at)
     VALUES ($1, 'Worker Test Household', $2, $2)`,
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

async function seedCatalog(opts: {
  commonName?: string;
  daysToMaturityMin?: number | null;
  daysToMaturityMax?: number | null;
  status?: 'pending' | 'published';
} = {}): Promise<string> {
  const id = uid('cw-cat');
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO catalog_seeds
       (id, common_name, days_to_maturity_min, days_to_maturity_max,
        status, created_at, updated_at, published_at)
     VALUES ($1, $2, $3, $4, $5, $6::BIGINT, $6::BIGINT,
             CASE WHEN $5 = 'published' THEN $6::BIGINT ELSE NULL END)`,
    [
      id,
      opts.commonName ?? 'Tomato',
      opts.daysToMaturityMin ?? 60,
      opts.daysToMaturityMax ?? 80,
      opts.status ?? 'published',
      now,
    ],
  );
  cleanup.catalogIds.add(id);
  return id;
}

async function seedCorrection(opts: {
  userId: string;
  householdId: string;
  catalogId: string;
  fieldName?: string;
  suggestedValue?: string;
  clientSeenValue?: string | null;
  acknowledged?: boolean;
  cachedReviewScore?: number;
  cachedNormalized?: string | number;
}): Promise<string> {
  const id = `cf_${nanoid(12)}`;
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO catalog_feedback
       (id, catalog_seed_id, household_id, user_id, body, field_name,
        suggested_value, client_seen_value, value_type, catalog_seed_name,
        user_acknowledged_bounds, status, created_at, updated_at,
        ai_review_score, ai_self_confidence)
     VALUES ($1, $2, $3, $4, 'body', $5, $6, $7, 'integer', 'Tomato', $8,
             'open', $9::BIGINT, $9::BIGINT, $10, $11)`,
    [
      id,
      opts.catalogId,
      opts.householdId,
      opts.userId,
      opts.fieldName ?? 'days_to_maturity_min',
      opts.suggestedValue ?? '70',
      opts.clientSeenValue ?? '60',
      opts.acknowledged ?? false,
      now,
      opts.cachedReviewScore ?? null,
      opts.cachedReviewScore !== undefined ? 0.5 : null,
    ],
  );
  cleanup.correctionIds.add(id);
  return id;
}

function mockReviewer(result: AiReviewResult): (args: ReviewCorrectionArgs) => Promise<AiReviewResult> {
  return async () => result;
}

beforeAll(async () => {
  await sql`SELECT 1`;
});

// Ensure each test sees a clean queue — no stale open rows from prior
// tests can leak into processOne's claim. Purge every catalog_feedback
// row that's still 'open' before each test so processOne can only see
// what the test just inserted.
beforeEach(async () => {
  await sql.unsafe(`DELETE FROM catalog_audit_log WHERE catalog_seed_id LIKE 'cw-cat-%'`);
  await sql.unsafe(`DELETE FROM catalog_feedback WHERE status = 'open'`);
});

afterAll(async () => {
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

describe('outcomeStatus (pure)', () => {
  it('attempts < max → pending', () => {
    expect(outcomeStatus(1, 5)).toBe('pending');
  });
  it('attempts >= max → failed', () => {
    expect(outcomeStatus(5, 5)).toBe('failed');
  });
  it('rate_limited → pending regardless of attempts', () => {
    expect(outcomeStatus(99, 5, 'rate_limited')).toBe('pending');
  });
  it('unauthorized → pending regardless of attempts', () => {
    expect(outcomeStatus(99, 5, 'unauthorized')).toBe('pending');
  });
});

describe('reapOrphanedClaims', () => {
  it('clears ai_locked_at older than REAPER_TIMEOUT_MS', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();
    const id = await seedCorrection({ userId: fx.userId, householdId: fx.householdId, catalogId });
    const old = Date.now() - REAPER_TIMEOUT_MS - 60_000;
    await sql.unsafe(`UPDATE catalog_feedback SET ai_locked_at = $1 WHERE id = $2`, [old, id]);
    const cleared = await reapOrphanedClaims(sql);
    expect(cleared).toBeGreaterThanOrEqual(1);
    const rows = await sql.unsafe<{ ai_locked_at: number | null }[]>(
      `SELECT ai_locked_at FROM catalog_feedback WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.ai_locked_at).toBeNull();
  });

  it('leaves fresh locks alone', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();
    const id = await seedCorrection({ userId: fx.userId, householdId: fx.householdId, catalogId });
    const fresh = Date.now() - 5 * 60_000;
    await sql.unsafe(`UPDATE catalog_feedback SET ai_locked_at = $1 WHERE id = $2`, [fresh, id]);
    await reapOrphanedClaims(sql);
    const rows = await sql.unsafe<{ ai_locked_at: number | null }[]>(
      `SELECT ai_locked_at FROM catalog_feedback WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.ai_locked_at).toBe(fresh);
  });
});

describe('sweepAuditLog', () => {
  it('deletes rows older than retention window', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog();
    const id = await seedCorrection({ userId: fx.userId, householdId: fx.householdId, catalogId });
    const old = Date.now() - AUDIT_LOG_RETENTION_MS - 86_400_000;
    const fresh = Date.now() - 1_000;
    await sql.unsafe(
      `INSERT INTO catalog_audit_log
         (id, catalog_seed_id, field_name, old_value, new_value, source,
          correction_id, actor_user_id, created_at)
       VALUES ($1, $2, 'days_to_maturity_min', '60', '70', 'auto_apply',
               $3, $4, $5)`,
      [`cal_${nanoid(12)}`, catalogId, id, fx.userId, old],
    );
    await sql.unsafe(
      `INSERT INTO catalog_audit_log
         (id, catalog_seed_id, field_name, old_value, new_value, source,
          correction_id, actor_user_id, created_at)
       VALUES ($1, $2, 'days_to_maturity_max', '80', '90', 'auto_apply',
               $3, $4, $5)`,
      [`cal_${nanoid(12)}`, catalogId, id, fx.userId, fresh],
    );
    const deleted = await sweepAuditLog(sql);
    expect(deleted).toBeGreaterThanOrEqual(1);
    const remaining = await sql.unsafe<{ ct: number }[]>(
      `SELECT count(*)::int AS ct FROM catalog_audit_log WHERE catalog_seed_id = $1`,
      [catalogId],
    );
    expect(remaining[0]?.ct).toBe(1);
  });
});

describe('processOne — auto_apply happy path', () => {
  it('mutates catalog + writes audit + flips correction to applied', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog({ daysToMaturityMin: 60 });
    const id = await seedCorrection({
      userId: fx.userId,
      householdId: fx.householdId,
      catalogId,
      suggestedValue: '65',
      clientSeenValue: '60',
    });

    const ok = await processOne(TEST_ENV, sql, {
      review: mockReviewer({
        ok: true,
        reviewScore: 0.95,
        selfConfidence: 0.9,
        normalizedValue: 65,
        notes: 'within typical cherry tomato range',
        raw: { mocked: true },
      }),
    });
    expect(ok).toBe(true);

    const cat = await sql.unsafe<{ days_to_maturity_min: number | null }[]>(
      `SELECT days_to_maturity_min FROM catalog_seeds WHERE id = $1`,
      [catalogId],
    );
    expect(cat[0]?.days_to_maturity_min).toBe(65);

    const feedback = await sql.unsafe<{ status: string; applied_at: number | null }[]>(
      `SELECT status, applied_at FROM catalog_feedback WHERE id = $1`,
      [id],
    );
    expect(feedback[0]?.status).toBe('applied');
    expect(feedback[0]?.applied_at).not.toBeNull();

    const audit = await sql.unsafe<{ source: string; old_value: string | null; new_value: string | null }[]>(
      `SELECT source, old_value, new_value FROM catalog_audit_log WHERE correction_id = $1`,
      [id],
    );
    expect(audit[0]?.source).toBe('auto_apply');
    expect(audit[0]?.old_value).toBe('60');
    expect(audit[0]?.new_value).toBe('65');
  });
});

describe('processOne — OCC conflict', () => {
  it('catalog mutated between submit and apply → status reviewed with occ_conflict', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog({ daysToMaturityMin: 60 });
    const id = await seedCorrection({
      userId: fx.userId,
      householdId: fx.householdId,
      catalogId,
      suggestedValue: '65',
      clientSeenValue: '60',
    });

    // Mutate the catalog AFTER seeding but BEFORE processOne sees it.
    await sql.unsafe(
      `UPDATE catalog_seeds SET days_to_maturity_min = 62 WHERE id = $1`,
      [catalogId],
    );

    await processOne(TEST_ENV, sql, {
      review: mockReviewer({
        ok: true,
        reviewScore: 0.95,
        selfConfidence: 0.9,
        normalizedValue: 65,
        notes: 'ok',
        raw: {},
      }),
    });

    const feedback = await sql.unsafe<{ status: string; dismissed_reason: string | null }[]>(
      `SELECT status, dismissed_reason FROM catalog_feedback WHERE id = $1`,
      [id],
    );
    expect(feedback[0]?.status).toBe('reviewed');
    expect(feedback[0]?.dismissed_reason).toBe('occ_conflict');
    const cat = await sql.unsafe<{ days_to_maturity_min: number | null }[]>(
      `SELECT days_to_maturity_min FROM catalog_seeds WHERE id = $1`,
      [catalogId],
    );
    expect(cat[0]?.days_to_maturity_min).toBe(62);
  });
});

describe('processOne — stale-target guard', () => {
  it('catalog unpublished between claim and apply → dismissed catalog_entry_unavailable', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog({ daysToMaturityMin: 60 });
    const id = await seedCorrection({
      userId: fx.userId,
      householdId: fx.householdId,
      catalogId,
      suggestedValue: '65',
    });
    await sql.unsafe(`UPDATE catalog_seeds SET status = 'pending' WHERE id = $1`, [catalogId]);

    let reviewCalled = false;
    const review = async (): Promise<AiReviewResult> => {
      reviewCalled = true;
      return { ok: true, reviewScore: 0.95, selfConfidence: 0.9, normalizedValue: 65, notes: '', raw: {} };
    };
    await processOne(TEST_ENV, sql, { review });

    expect(reviewCalled).toBe(false);
    const feedback = await sql.unsafe<{ status: string; dismissed_reason: string | null }[]>(
      `SELECT status, dismissed_reason FROM catalog_feedback WHERE id = $1`,
      [id],
    );
    expect(feedback[0]?.status).toBe('dismissed');
    expect(feedback[0]?.dismissed_reason).toBe('catalog_entry_unavailable');
  });
});

describe('processOne — AI cache (crash-recovery)', () => {
  it('cached ai_review_score skips the AI call', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog({ daysToMaturityMin: 60 });
    const id = await seedCorrection({
      userId: fx.userId,
      householdId: fx.householdId,
      catalogId,
      suggestedValue: '65',
      clientSeenValue: '60',
      cachedReviewScore: 0.95,
    });

    let reviewCalled = false;
    const review = async (): Promise<AiReviewResult> => {
      reviewCalled = true;
      return { ok: true, reviewScore: 0, selfConfidence: 0, normalizedValue: null, notes: '', raw: {} };
    };
    await processOne(TEST_ENV, sql, { review });

    expect(reviewCalled).toBe(false);
    const feedback = await sql.unsafe<{ status: string }[]>(
      `SELECT status FROM catalog_feedback WHERE id = $1`,
      [id],
    );
    expect(feedback[0]?.status).toBe('applied');
  });
});

describe('processOne — AI low confidence → auto_dismiss', () => {
  it('review_score < 0.30 dismisses with ai_low_confidence', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog({ daysToMaturityMin: 60 });
    const id = await seedCorrection({
      userId: fx.userId,
      householdId: fx.householdId,
      catalogId,
      suggestedValue: '65',
    });

    await processOne(TEST_ENV, sql, {
      review: mockReviewer({
        ok: true,
        reviewScore: 0.1,
        selfConfidence: 0.05,
        normalizedValue: null,
        notes: 'not confident',
        raw: {},
      }),
    });

    const feedback = await sql.unsafe<{ status: string; dismissed_reason: string | null }[]>(
      `SELECT status, dismissed_reason FROM catalog_feedback WHERE id = $1`,
      [id],
    );
    expect(feedback[0]?.status).toBe('dismissed');
    expect(feedback[0]?.dismissed_reason).toBe('ai_low_confidence');
  });
});

describe('processOne — AI server_error backoff', () => {
  it('attempts increment + ai_next_attempt_at set', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog({ daysToMaturityMin: 60 });
    const id = await seedCorrection({
      userId: fx.userId,
      householdId: fx.householdId,
      catalogId,
      suggestedValue: '65',
    });

    await processOne(TEST_ENV, sql, {
      review: mockReviewer({ ok: false, error: { kind: 'server_error', status: 500, body: 'oops' } }),
    });
    const rows = await sql.unsafe<{ ai_attempts: number; ai_next_attempt_at: number | null; status: string }[]>(
      `SELECT ai_attempts, ai_next_attempt_at, status FROM catalog_feedback WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.ai_attempts).toBe(1);
    expect(rows[0]?.ai_next_attempt_at).not.toBeNull();
    expect(rows[0]?.status).toBe('open');
  });
});

describe('processOne — concurrent_conflict', () => {
  it('two corrections same (seed, field) with different values → both reviewed concurrent_conflict', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog({ daysToMaturityMin: 60 });
    const id1 = await seedCorrection({
      userId: fx.userId,
      householdId: fx.householdId,
      catalogId,
      suggestedValue: '65',
    });
    // Same user/seed/field is blocked by the partial UNIQUE; conflict
    // requires a second user. Spin one up.
    const fx2 = await seedAuthFixture();
    const id2 = await seedCorrection({
      userId: fx2.userId,
      householdId: fx2.householdId,
      catalogId,
      suggestedValue: '70',
    });

    await processOne(TEST_ENV, sql, {
      review: mockReviewer({
        ok: true,
        reviewScore: 0.95,
        selfConfidence: 0.9,
        normalizedValue: 65,
        notes: '',
        raw: {},
      }),
    });
    const rows = await sql.unsafe<{ id: string; status: string; dismissed_reason: string | null; conflict_with_id: string | null }[]>(
      `SELECT id, status, dismissed_reason, conflict_with_id FROM catalog_feedback
        WHERE id IN ($1, $2)`,
      [id1, id2],
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.status).toBe('reviewed');
      expect(r.dismissed_reason).toBe('concurrent_conflict');
      expect(r.conflict_with_id).not.toBeNull();
    }
  });
});

describe('processOne — recent_change guard', () => {
  it('an auto_apply within 24h on same (seed, field) routes to reviewed recent_change', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog({ daysToMaturityMin: 60 });
    const id = await seedCorrection({
      userId: fx.userId,
      householdId: fx.householdId,
      catalogId,
      suggestedValue: '65',
    });
    // Plant a recent auto_apply audit row.
    await sql.unsafe(
      `INSERT INTO catalog_audit_log
         (id, catalog_seed_id, field_name, old_value, new_value, source,
          correction_id, actor_user_id, created_at)
       VALUES ($1, $2, 'days_to_maturity_min', '55', '60', 'auto_apply',
               NULL, NULL, $3)`,
      [`cal_${nanoid(12)}`, catalogId, Date.now() - 60_000],
    );

    await processOne(TEST_ENV, sql, {
      review: mockReviewer({
        ok: true,
        reviewScore: 0.95,
        selfConfidence: 0.9,
        normalizedValue: 65,
        notes: '',
        raw: {},
      }),
    });
    const rows = await sql.unsafe<{ status: string; dismissed_reason: string | null }[]>(
      `SELECT status, dismissed_reason FROM catalog_feedback WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.status).toBe('reviewed');
    expect(rows[0]?.dismissed_reason).toBe('recent_change');
  });
});

describe('processOne — account_too_new', () => {
  it('user account < 7 days → routes to queue account_too_new', async () => {
    const fx = await seedAuthFixture({ accountAgeDays: 3 });
    const catalogId = await seedCatalog({ daysToMaturityMin: 60 });
    const id = await seedCorrection({
      userId: fx.userId,
      householdId: fx.householdId,
      catalogId,
      suggestedValue: '65',
      clientSeenValue: '60',
    });
    await processOne(TEST_ENV, sql, {
      review: mockReviewer({
        ok: true,
        reviewScore: 0.95,
        selfConfidence: 0.9,
        normalizedValue: 65,
        notes: '',
        raw: {},
      }),
    });
    const rows = await sql.unsafe<{ status: string; dismissed_reason: string | null }[]>(
      `SELECT status, dismissed_reason FROM catalog_feedback WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.status).toBe('reviewed');
    expect(rows[0]?.dismissed_reason).toBe('account_too_new');
  });
});

describe('processOne — household membership revoke trigger', () => {
  it('DELETE membership flips open corrections to dismissed household_membership_revoked', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog({ daysToMaturityMin: 60 });
    const id = await seedCorrection({
      userId: fx.userId,
      householdId: fx.householdId,
      catalogId,
      suggestedValue: '65',
    });

    await sql.unsafe(
      `DELETE FROM memberships WHERE user_id = $1 AND household_id = $2`,
      [fx.userId, fx.householdId],
    );

    const rows = await sql.unsafe<{ status: string; dismissed_reason: string | null }[]>(
      `SELECT status, dismissed_reason FROM catalog_feedback WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.status).toBe('dismissed');
    expect(rows[0]?.dismissed_reason).toBe('household_membership_revoked');
  });
});

describe('applyCorrectionOutcome — zombie guard', () => {
  it('UPDATE fails when ai_locked_at is NULL (no-op safe)', async () => {
    const fx = await seedAuthFixture();
    const catalogId = await seedCatalog({ daysToMaturityMin: 60 });
    const id = await seedCorrection({
      userId: fx.userId,
      householdId: fx.householdId,
      catalogId,
      suggestedValue: '65',
      clientSeenValue: '60',
    });

    // Simulate the row already unlocked (reaper cleared it).
    await sql.unsafe(`UPDATE catalog_feedback SET ai_locked_at = NULL WHERE id = $1`, [id]);

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

    // Apply auto_apply — the zombie guard should fire because ai_locked_at IS NULL.
    try {
      await applyCorrectionOutcome(
        sql,
        row,
        { action: 'auto_apply', normalizedValue: 65, reason: 'auto_apply' },
        { ok: true, reviewScore: 0.95, selfConfidence: 0.9, normalizedValue: 65, notes: '', raw: {} },
      );
      // The implementation throws ZombieGuardError internally; we treat
      // that as the safe path. Reaching here without an error is also
      // acceptable as long as the catalog wasn't mutated.
    } catch {
      // ok — guard fired
    }

    const cat = await sql.unsafe<{ days_to_maturity_min: number | null }[]>(
      `SELECT days_to_maturity_min FROM catalog_seeds WHERE id = $1`,
      [catalogId],
    );
    // Catalog must remain at original 60.
    expect(cat[0]?.days_to_maturity_min).toBe(60);
  });
});
