/**
 * Phase 4D · Catalog-correction moderation worker.
 *
 * Piggybacks the existing always-on Bun `worker` process. After
 * `processRecommendationJob` returns false (queue empty), the main
 * loop calls `processOneCorrection`. Independent try/catch around
 * each path so a throw in one cannot crash the other tick.
 *
 * Sequence per tick (see spec §6):
 *   1. Daily-sweep branch (once per UTC day, sentinel-gated).
 *   2. Reaper — clear ai_locked_at older than REAPER_TIMEOUT_MS.
 *   3. Atomic claim via FOR UPDATE SKIP LOCKED.
 *   4. Stale-target guard.
 *   5. Conflict guard.
 *   6. Recent-apply guard.
 *   7. AI-call cache check.
 *   8. AI moderation (separate tx for the result write).
 *   9. AI-failure dispatch.
 *  10. decideCorrectionOutcome (pure).
 *  11. applyCorrectionOutcome (ONE tx).
 *  12. (Implicit) recommendation invalidation via existing trigger.
 */

import type { Sql } from 'postgres';
import { nanoid } from 'nanoid';
import type { Env } from '../../env';
import { dbGet, dbRun } from '../../db/helpers';
import { reviewCorrection } from './aiReview';
import type { AiReviewError, AiReviewResult, ReviewCorrectionArgs } from './aiReview';
import { decideCorrectionOutcome } from './correctionDecision';
import type { DecideOutput, NeighborStats } from './correctionDecision';
import { computeUserQuota, fetchUserQuotaStats } from './userQuota';
import { AUTO_APPLY_FIELDS, CORRECTABLE_FIELDS, ENUM_VALUES, SANITY_BOUNDS } from './fieldBounds';

export const POLL_INTERVAL_MS = 5_000;

/**
 * Claim filter allowlist. field_name='other' (and any future
 * non-column value the CHECK admits) must never be claimed: step 4
 * interpolates the field into SQL against catalog_seeds columns.
 * Server-controlled constants — safe to inline as literals.
 */
const CLAIMABLE_FIELDS_SQL = [...CORRECTABLE_FIELDS].map((f) => `'${f}'`).join(', ');
export const MAX_ATTEMPTS = 5;
export const BACKOFF_MS = [60_000, 300_000, 1_800_000] as const;
export const REAPER_TIMEOUT_MS = 10 * 60_000;
export const AUDIT_LOG_RETENTION_MS = 18 * 30 * 86_400_000;
export const UNAUTHORIZED_PERSISTENT_AFTER_MS = 24 * 60 * 60_000;

export interface ClaimedCorrection {
  id: string;
  catalog_seed_id: string | null;
  household_id: string | null;
  user_id: string | null;
  field_name: string;
  suggested_value: string | null;
  client_seen_value: string | null;
  ai_attempts: number;
  ai_review_score: number | null;
  ai_self_confidence: number | null;
  ai_notes: string | null;
  ai_raw_response: unknown | null;
  user_acknowledged_bounds: boolean;
  idempotency_key: string | null;
}

interface CatalogTargetRow {
  id: string;
  status: 'pending' | 'published' | 'rejected';
  common_name: string;
  variety: string | null;
  company: string | null;
}

export type ReviewCallable = (args: ReviewCorrectionArgs) => Promise<AiReviewResult>;

export interface ProcessOneDeps {
  /** Test seam — defaults to the real `reviewCorrection`. */
  review?: ReviewCallable;
  /** Test seam — defaults to Date.now(). */
  now?: () => number;
}

export type OutcomeStatus = 'pending' | 'failed';

/** Pure: given a failure kind + attempts so far, decide pending vs failed. */
export function outcomeStatus(
  attempts: number,
  max: number,
  errorKind?: AiReviewError['kind'],
): OutcomeStatus {
  // unauthorized + rate_limited do NOT increment attempts — they only
  // schedule a later retry. Caller passes errorKind=undefined when the
  // call succeeded.
  if (errorKind === 'unauthorized' || errorKind === 'rate_limited' || errorKind === 'parse_error') {
    return 'pending';
  }
  return attempts >= max ? 'failed' : 'pending';
}

/**
 * Clear ai_locked_at on rows whose lock is older than REAPER_TIMEOUT_MS.
 * Returns the count cleared (for metrics).
 */
export async function reapOrphanedClaims(sql: Sql, now: number = Date.now()): Promise<number> {
  const cutoff = now - REAPER_TIMEOUT_MS;
  const result = await sql.unsafe(
    `UPDATE catalog_feedback
        SET ai_locked_at = NULL
      WHERE status = 'open' AND ai_locked_at IS NOT NULL AND ai_locked_at < $1`,
    [cutoff],
  );
  return Number((result as { count?: number }).count ?? 0);
}

/**
 * Delete audit log rows older than AUDIT_LOG_RETENTION_MS. Returns the
 * number deleted. Cheap when no rows are old enough.
 */
export async function sweepAuditLog(sql: Sql, now: number = Date.now()): Promise<number> {
  const cutoff = now - AUDIT_LOG_RETENTION_MS;
  const result = await sql.unsafe(
    `DELETE FROM catalog_audit_log WHERE created_at < $1 AND source != 'manual_revert'`,
    [cutoff],
  );
  return Number((result as { count?: number }).count ?? 0);
}

interface DispatchPlan {
  nextAttemptAt: number | null;
  attemptsIncrement: number;
  terminalReason: string | null;
}

function planAiFailureDispatch(
  attempts: number,
  error: AiReviewError,
  now: number,
  firstFailureAt: number | null,
): DispatchPlan {
  switch (error.kind) {
    case 'unauthorized': {
      const since = firstFailureAt ?? now;
      const persistent = now - since >= UNAUTHORIZED_PERSISTENT_AFTER_MS;
      return {
        nextAttemptAt: persistent ? null : now + 3_600_000,
        attemptsIncrement: 0,
        terminalReason: persistent ? 'ai_unauthorized_persistent' : null,
      };
    }
    case 'rate_limited': {
      const wait = Math.max(error.retryAfterSec * 1000, 60_000);
      return { nextAttemptAt: now + wait, attemptsIncrement: 0, terminalReason: null };
    }
    case 'server_error':
    case 'timeout':
    case 'network_error': {
      const newAttempts = attempts + 1;
      if (newAttempts >= MAX_ATTEMPTS) {
        return { nextAttemptAt: null, attemptsIncrement: 1, terminalReason: 'ai_max_attempts' };
      }
      const backoff = BACKOFF_MS[Math.min(newAttempts - 1, BACKOFF_MS.length - 1)];
      return { nextAttemptAt: now + backoff, attemptsIncrement: 1, terminalReason: null };
    }
    case 'parse_error': {
      // sentinel review_score=0 → decide normally. No retry, no
      // attempts increment, no terminal.
      return { nextAttemptAt: null, attemptsIncrement: 0, terminalReason: null };
    }
  }
}

function colTypeForField(field: string): string {
  if (field === 'seed_depth_inches') return 'numeric';
  if (
    field === 'sun_requirement' ||
    field === 'frost_tolerance' ||
    field === 'sow_method' ||
    field === 'life_cycle' ||
    field === 'scientific_name' ||
    field === 'common_name' ||
    field === 'variety' ||
    field === 'company' ||
    field === 'instructions'
  ) {
    return 'text';
  }
  return 'integer';
}

function isNumericField(field: string): boolean {
  return field === 'seed_depth_inches' || (SANITY_BOUNDS[field] !== undefined && ENUM_VALUES[field] === undefined);
}

/** Stringify a value the same way the DB stringifies it for OCC comparison. */
function stringifyForOcc(v: string | number | null): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

/**
 * Apply the decision in ONE transaction. Every catalog_feedback UPDATE
 * includes `WHERE status = 'open' AND ai_locked_at IS NOT NULL` guards:
 * a zombie worker's late apply, or a row the user withdrew mid-claim,
 * affects 0 rows and the path aborts cleanly.
 */
export async function applyCorrectionOutcome(
  sql: Sql,
  row: ClaimedCorrection,
  outcome: DecideOutput,
  aiMeta: AiReviewResult | null,
  now: number = Date.now(),
  claimTs: number | null = null,
): Promise<void> {
  // Ownership-fence clause: when claimTs is provided (processOne path),
  // require exact match on ai_locked_at to prevent a stale/reaped claim
  // from clobbering a row re-claimed by a newer tick.
  // lockParamOffset(n) returns { clause, extra } where clause is the SQL
  // fragment and extra is the extra param array to append (empty or [claimTs]).
  // n = number of positional params already in the query before this clause.
  const lockParamOffset = (n: number): { clause: string; extra: (number)[] } =>
    claimTs !== null
      ? { clause: `ai_locked_at = $${n + 1}`, extra: [claimTs] }
      : { clause: `ai_locked_at IS NOT NULL`, extra: [] };

  if (outcome.action === 'auto_apply') {
    await sql.begin(async (tx) => {
      const colType = colTypeForField(row.field_name);
      const normalized = outcome.normalizedValue;
      if (normalized === undefined) {
        throw new Error('auto_apply outcome missing normalizedValue');
      }
      let occ = stringifyForOcc(row.client_seen_value as string | number | null);
      // Numeric/integer columns compare numerically so Postgres's
      // scale-padded text rendering ('0.50') matches the client's
      // JS-number form ('0.5'). Text/enum columns keep text equality.
      const occClause = colType === 'text'
        ? `CAST(${row.field_name} AS TEXT) IS NOT DISTINCT FROM $4`
        : `${row.field_name} IS NOT DISTINCT FROM $4::numeric`;
      if (colType !== 'text' && occ !== null && occ.trim() === '') {
        occ = null;
      }

      // Fetch current value to write to audit log.
      const cur = await tx.unsafe<{ old_value: string | null }[]>(
        `SELECT CAST(${row.field_name} AS TEXT) AS old_value
           FROM catalog_seeds WHERE id = $1`,
        [row.catalog_seed_id],
      );
      const oldValue = cur[0]?.old_value ?? null;

      const updateResult = await tx.unsafe(
        `UPDATE catalog_seeds
            SET ${row.field_name} = $2::${colType}, updated_at = $3
          WHERE id = $1
            AND ${occClause}
            AND status = 'published'`,
        [row.catalog_seed_id, normalized, now, occ],
      );
      if (Number((updateResult as { count?: number }).count ?? 0) === 0) {
        throw new ZombieGuardError('occ_conflict');
      }

      await tx.unsafe(
        `INSERT INTO catalog_audit_log
           (id, catalog_seed_id, field_name, old_value, new_value, source,
            correction_id, actor_user_id, ai_self_confidence, ai_review_score,
            ai_raw_response, created_at)
         VALUES ($1, $2, $3, $4, $5, 'auto_apply', $6, $7, $8, $9, $10, $11)`,
        [
          `cal_${nanoid(12)}`,
          row.catalog_seed_id,
          row.field_name,
          oldValue,
          String(normalized),
          row.id,
          row.user_id,
          aiMeta && aiMeta.ok ? aiMeta.selfConfidence : null,
          aiMeta && aiMeta.ok ? aiMeta.reviewScore : null,
          aiMeta && aiMeta.ok ? JSON.stringify(aiMeta.raw) : null,
          now,
        ],
      );

      const { clause: applyLock, extra: applyExtra } = lockParamOffset(2);
      const feedbackResult = await tx.unsafe(
        `UPDATE catalog_feedback
            SET status = 'applied', applied_at = $2, reviewed_at = $2,
                updated_at = $2, ai_locked_at = NULL
          WHERE id = $1 AND status = 'open' AND ${applyLock}`,
        [row.id, now, ...applyExtra],
      );
      if (Number((feedbackResult as { count?: number }).count ?? 0) === 0) {
        throw new ZombieGuardError('zombie_apply');
      }
    });
    return;
  }

  if (outcome.action === 'auto_dismiss') {
    const { clause: dismissLock, extra: dismissExtra } = lockParamOffset(3);
    await dbRun(
      sql,
      `UPDATE catalog_feedback
          SET status = 'dismissed', dismissed_reason = $2, reviewed_at = $3,
              updated_at = $3, ai_locked_at = NULL
        WHERE id = $1 AND status = 'open' AND ${dismissLock}`,
      [row.id, outcome.reason, now, ...dismissExtra],
    );
    return;
  }

  // queue_for_review
  const { clause: queueLock, extra: queueExtra } = lockParamOffset(3);
  await dbRun(
    sql,
    `UPDATE catalog_feedback
        SET status = 'reviewed', dismissed_reason = $2, reviewed_at = $3,
            updated_at = $3, ai_locked_at = NULL
      WHERE id = $1 AND status = 'open' AND ${queueLock}`,
    [row.id, outcome.reason, now, ...queueExtra],
  );
}

export class ZombieGuardError extends Error {
  constructor(public readonly code: 'occ_conflict' | 'zombie_apply') {
    super(code);
  }
}

/**
 * One claim+process tick. Returns true when work was done (claim landed),
 * false when the queue was empty. Throws only on unexpected DB errors —
 * AI failures land in the row's `ai_last_error` field, never as throws.
 */
export async function processOne(env: Env, sql: Sql, deps: ProcessOneDeps = {}): Promise<boolean> {
  // Tick-start `now` drives the claim filter + guard windows. Every
  // terminal write stamps a FRESH `nowFn()` instead — the delta feed is
  // a strict `updated_at > since` cursor, and a write backdated to
  // tick-start can land behind a cursor that already advanced past it.
  const nowFn = deps.now ?? Date.now;
  const now = nowFn();

  // Step 1 — daily sweep gate (best-effort, swallow errors so a sweep
  // failure can't crash the tick).
  try {
    await maybeSweep(sql, now);
  } catch (err) {
    console.error('[corrections] sweep error', err);
  }

  // Step 2 — reaper.
  try {
    await reapOrphanedClaims(sql, now);
  } catch (err) {
    console.error('[corrections] reaper error', err);
  }

  // Step 3 — atomic claim.
  const claimed = await sql.begin(async (tx) => {
    const rows = await tx.unsafe<ClaimedCorrection[]>(
      `
      SELECT id, catalog_seed_id, household_id, user_id, field_name,
             suggested_value, client_seen_value, ai_attempts, ai_review_score,
             ai_self_confidence, ai_notes, ai_raw_response,
             user_acknowledged_bounds, idempotency_key
        FROM catalog_feedback
       WHERE status = 'open'
         AND field_name IN (${CLAIMABLE_FIELDS_SQL})
         AND ai_locked_at IS NULL
         AND (ai_next_attempt_at IS NULL OR ai_next_attempt_at <= $1)
       ORDER BY COALESCE(ai_next_attempt_at, created_at)
       LIMIT 1
       FOR UPDATE SKIP LOCKED
      `,
      [now],
    );
    const row = rows[0];
    if (!row) return null;
    await tx.unsafe(
      `UPDATE catalog_feedback SET ai_locked_at = $2 WHERE id = $1`,
      [row.id, now],
    );
    return row;
  });

  if (!claimed) return false;

  // Step 4 — stale-target guard. Also pull the current value of the
  // field we may mutate so OCC can compare against it.
  const target = claimed.catalog_seed_id
    ? await dbGet<CatalogTargetRow & { current_value: string | null }>(
        sql,
        `SELECT id, status, common_name, variety, company,
                CAST(${claimed.field_name} AS TEXT) AS current_value
           FROM catalog_seeds WHERE id = $1 LIMIT 1`,
        [claimed.catalog_seed_id],
      )
    : null;
  // claimTs is the value written into ai_locked_at at claim time. All
  // guarded UPDATEs below use exact-match ownership fencing so a stale
  // (reaped) claim cannot clobber a row re-claimed by a newer tick.
  const claimTs = now;

  if (!target || target.status !== 'published') {
    await dbRun(
      sql,
      `UPDATE catalog_feedback
          SET status = 'dismissed', dismissed_reason = 'catalog_entry_unavailable',
              reviewed_at = $2, updated_at = $2, ai_locked_at = NULL
        WHERE id = $1 AND status = 'open' AND ai_locked_at = $3`,
      [claimed.id, nowFn(), claimTs],
    );
    return true;
  }

  // Step 5 — conflict guard.
  const conflicts = await sql.unsafe<{ id: string; suggested_value: string | null }[]>(
    `SELECT id, suggested_value FROM catalog_feedback
      WHERE catalog_seed_id = $1 AND field_name = $2 AND status = 'open' AND id <> $3`,
    [claimed.catalog_seed_id, claimed.field_name, claimed.id],
  );
  const differing = conflicts.find((c) => (c.suggested_value ?? '') !== (claimed.suggested_value ?? ''));
  let hasConflict = false;
  if (differing) {
    hasConflict = true;
    // Cross-link and mark both as reviewed with concurrent_conflict.
    const conflictNow = nowFn();
    await sql.begin(async (tx) => {
      await tx.unsafe(
        `UPDATE catalog_feedback
            SET status = 'reviewed', dismissed_reason = 'concurrent_conflict',
                conflict_with_id = $2, reviewed_at = $3, updated_at = $3,
                ai_locked_at = NULL
          WHERE id = $1 AND status = 'open' AND ai_locked_at = $4`,
        [claimed.id, differing.id, conflictNow, claimTs],
      );
      await tx.unsafe(
        `UPDATE catalog_feedback
            SET status = 'reviewed', dismissed_reason = 'concurrent_conflict',
                conflict_with_id = $2, reviewed_at = $3, updated_at = $3
          WHERE id = $1 AND status = 'open'`,
        [differing.id, claimed.id, conflictNow],
      );
    });
    return true;
  }

  // Step 6 — recent-apply guard.
  const oneDayAgo = now - 86_400_000;
  const recentRow = await dbGet<{ ct: number }>(
    sql,
    `SELECT count(*)::int AS ct FROM catalog_audit_log
      WHERE catalog_seed_id = $1 AND field_name = $2
        AND created_at > $3 AND source = 'auto_apply'`,
    [claimed.catalog_seed_id, claimed.field_name, oneDayAgo],
  );
  if ((recentRow?.ct ?? 0) >= 1) {
    await dbRun(
      sql,
      `UPDATE catalog_feedback
          SET status = 'reviewed', dismissed_reason = 'recent_change',
              reviewed_at = $2, updated_at = $2, ai_locked_at = NULL
        WHERE id = $1 AND status = 'open' AND ai_locked_at = $3`,
      [claimed.id, nowFn(), claimTs],
    );
    return true;
  }

  // Step 7 + 8 — AI call (cache check inside).
  let aiResult: AiReviewResult | null = null;
  const hasCachedScore = claimed.ai_review_score !== null && claimed.ai_review_score !== undefined;
  if (hasCachedScore) {
    aiResult = {
      ok: true,
      reviewScore: Number(claimed.ai_review_score),
      selfConfidence: Number(claimed.ai_self_confidence ?? 0),
      normalizedValue: parseSuggested(claimed.field_name, claimed.suggested_value),
      notes: claimed.ai_notes ?? '',
      raw: claimed.ai_raw_response,
    };
  } else if (!env.ANTHROPIC_API_KEY) {
    // No API key — route to queue with a marker reason. Doesn't crash the tick.
    await dbRun(
      sql,
      `UPDATE catalog_feedback
          SET status = 'reviewed', dismissed_reason = 'ai_unconfigured',
              reviewed_at = $2, updated_at = $2, ai_locked_at = NULL
        WHERE id = $1 AND status = 'open' AND ai_locked_at = $3`,
      [claimed.id, nowFn(), claimTs],
    );
    return true;
  } else {
    const reviewFn = deps.review ?? reviewCorrection;
    const parsed = parseSuggested(claimed.field_name, claimed.suggested_value);
    aiResult = await reviewFn({
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.DEFAULT_REVIEW_MODEL,
      fieldName: claimed.field_name,
      currentValue: extractCurrentValue(target, claimed.field_name),
      suggestedValue: parsed ?? (claimed.suggested_value ?? ''),
      catalogContext: {
        common_name: target.common_name,
        variety: target.variety,
        company: target.company,
      },
    });

    // Step 8 — persist AI result in a SEPARATE tx before apply so a
    // crash on apply doesn't re-bill Anthropic.
    if (aiResult.ok) {
      const persisted = await dbRun(
        sql,
        `UPDATE catalog_feedback
            SET ai_review_score = $2, ai_self_confidence = $3, ai_notes = $4,
                ai_raw_response = $5, ai_attempts = ai_attempts + 1, ai_last_error = NULL,
                updated_at = $6
          WHERE id = $1 AND status = 'open' AND ai_locked_at = $7`,
        [
          claimed.id,
          aiResult.reviewScore,
          aiResult.selfConfidence,
          aiResult.notes,
          JSON.stringify(aiResult.raw),
          nowFn(),
          claimTs,
        ],
      );
      if (persisted.meta.changes === 0) {
        // Row escaped (withdrawn / reaped + reclaimed) mid-AI-call.
        return true;
      }
    } else {
      // Step 9 — failure dispatch.
      const firstFailureAt = await firstUnauthorizedAt(sql, claimed.id);
      const plan = planAiFailureDispatch(
        claimed.ai_attempts,
        aiResult.error,
        now,
        firstFailureAt,
      );
      if (plan.terminalReason) {
        await dbRun(
          sql,
          `UPDATE catalog_feedback
              SET status = 'reviewed', dismissed_reason = $2,
                  ai_attempts = ai_attempts + $3, ai_last_error = $4,
                  reviewed_at = $5, updated_at = $5, ai_locked_at = NULL
            WHERE id = $1 AND status = 'open' AND ai_locked_at = $6`,
          [
            claimed.id,
            plan.terminalReason,
            plan.attemptsIncrement,
            describeError(aiResult.error),
            nowFn(),
            claimTs,
          ],
        );
        return true;
      }
      // Non-terminal — release lock and schedule next attempt.
      if (aiResult.error.kind === 'parse_error') {
        // parse_error → sentinel score 0, decide normally below.
        aiResult = {
          ok: true,
          reviewScore: 0,
          selfConfidence: 0,
          normalizedValue: null,
          notes: 'unparseable',
          raw: { parse_error: aiResult.error.raw },
        };
        const persisted = await dbRun(
          sql,
          `UPDATE catalog_feedback
              SET ai_review_score = 0, ai_self_confidence = 0, ai_notes = 'unparseable',
                  ai_raw_response = $2, ai_attempts = ai_attempts,
                  ai_last_error = $3, updated_at = $4
            WHERE id = $1 AND status = 'open' AND ai_locked_at = $5`,
          [claimed.id, JSON.stringify({ parse_error: true }), 'parse_error', nowFn(), claimTs],
        );
        if (persisted.meta.changes === 0) {
          // Row escaped (withdrawn / reaped + reclaimed) mid-AI-call.
          return true;
        }
      } else {
        await dbRun(
          sql,
          `UPDATE catalog_feedback
              SET ai_attempts = ai_attempts + $2, ai_last_error = $3,
                  ai_next_attempt_at = $4, updated_at = $5, ai_locked_at = NULL
            WHERE id = $1 AND status = 'open' AND ai_locked_at = $6`,
          [
            claimed.id,
            plan.attemptsIncrement,
            describeError(aiResult.error),
            plan.nextAttemptAt,
            nowFn(),
            claimTs,
          ],
        );
        return true;
      }
    }
  }

  // Step 10 — decision.
  const userId = claimed.user_id;
  let accountAgeDays = 0;
  let quotaRemaining = 0;
  if (userId) {
    accountAgeDays = await fetchAccountAgeDays(sql, userId, now);
    const stats = await fetchUserQuotaStats(sql, userId);
    const quota = computeUserQuota(stats);
    quotaRemaining = quota.remaining;
  }

  const neighborStats = AUTO_APPLY_FIELDS.has(claimed.field_name) && isNumericField(claimed.field_name)
    ? await fetchNeighborStats(sql, target, claimed.field_name)
    : null;

  const outcome = decideCorrectionOutcome({
    fieldName: claimed.field_name,
    suggestedValueRaw: claimed.suggested_value ?? '',
    aiNormalizedValue: aiResult.ok ? aiResult.normalizedValue : null,
    currentValue: extractCurrentValue(target, claimed.field_name),
    neighborStats,
    clientSeenValue: claimed.client_seen_value,
    aiReviewScore: aiResult.ok ? aiResult.reviewScore : 0,
    hasConflict,
    hasRecentApply: false,
    userAcknowledgedBounds: claimed.user_acknowledged_bounds,
    userAccountAgeDays: accountAgeDays,
    userQuotaRemaining: quotaRemaining,
  });

  // Step 11 — apply.
  try {
    await applyCorrectionOutcome(sql, claimed, outcome, aiResult, nowFn(), claimTs);
  } catch (err) {
    if (err instanceof ZombieGuardError) {
      if (err.code === 'occ_conflict') {
        // The catalog_seeds row moved underneath us — route to queue.
        const fallback: DecideOutput = {
          action: 'queue_for_review',
          reason: 'occ_conflict',
          normalizedValue: outcome.normalizedValue,
        };
        // Re-acquire the lock-flag invariant by reasserting ai_locked_at
        // is NULL via a fresh UPDATE that doesn't depend on the apply tx.
        // Ownership fence: only clear the lock if we still own it
        // (claimTs exact-match mirrors the lockClause in applyCorrectionOutcome).
        const occLockClause = claimTs !== null
          ? `AND ai_locked_at = $4`
          : `AND ai_locked_at IS NOT NULL`;
        await dbRun(
          sql,
          `UPDATE catalog_feedback
              SET status = 'reviewed', dismissed_reason = $2,
                  reviewed_at = $3, updated_at = $3, ai_locked_at = NULL
            WHERE id = $1 AND status = 'open' ${occLockClause}`,
          claimTs !== null
            ? [claimed.id, fallback.reason, nowFn(), claimTs]
            : [claimed.id, fallback.reason, nowFn()],
        );
        return true;
      }
      // zombie_apply — the row escaped (withdrawn or another worker
      // finalized it). Leave row as-is.
      return true;
    }
    // Cross-field invariant violation surfaces as Postgres 23514.
    const code = (err as { code?: string }).code;
    if (code === '23514') {
      const cf14LockClause = claimTs !== null
        ? `AND ai_locked_at = $3`
        : `AND ai_locked_at IS NOT NULL`;
      await dbRun(
        sql,
        `UPDATE catalog_feedback
            SET status = 'reviewed', dismissed_reason = 'cross_field_invariant',
                reviewed_at = $2, updated_at = $2, ai_locked_at = NULL
          WHERE id = $1 AND status = 'open' ${cf14LockClause}`,
        claimTs !== null
          ? [claimed.id, nowFn(), claimTs]
          : [claimed.id, nowFn()],
      );
      return true;
    }
    throw err;
  }

  return true;
}

function describeError(err: AiReviewError): string {
  switch (err.kind) {
    case 'unauthorized': return 'unauthorized';
    case 'rate_limited': return `rate_limited (retry ${err.retryAfterSec}s)`;
    case 'server_error': return `server_error ${err.status}`;
    case 'timeout': return 'timeout';
    case 'network_error': return `network_error: ${err.message}`;
    case 'parse_error': return 'parse_error';
  }
}

function parseSuggested(field: string, raw: string | null): string | number | null {
  if (raw === null || raw === undefined) return null;
  if (ENUM_VALUES[field]) return raw.trim().toLowerCase();
  if (SANITY_BOUNDS[field]) {
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  }
  return raw;
}

function extractCurrentValue(
  target: (CatalogTargetRow & { current_value?: string | null }) | null,
  field: string,
): string | null {
  void field;
  if (!target) return null;
  return target.current_value ?? null;
}

async function fetchAccountAgeDays(sql: Sql, userId: string, now: number): Promise<number> {
  const row = await dbGet<{ created_at_ms: number | null }>(
    sql,
    `SELECT (EXTRACT(EPOCH FROM "createdAt") * 1000)::BIGINT AS created_at_ms
       FROM "user" WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const createdMs = row?.created_at_ms;
  if (!createdMs) return 0;
  const ageMs = now - Number(createdMs);
  return Math.max(0, Math.floor(ageMs / 86_400_000));
}

async function fetchNeighborStats(
  sql: Sql,
  target: CatalogTargetRow,
  field: string,
): Promise<NeighborStats | null> {
  if (!isNumericField(field) || !target.common_name) return null;
  // Median + stdev across published catalog rows sharing common_name.
  // Cheap because catalog table is small and common_name is indexed.
  const row = await dbGet<{ med: number | null; sd: number | null; ct: number }>(
    sql,
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ${field}) AS med,
            stddev_samp(${field}::numeric) AS sd,
            count(*)::int AS ct
       FROM catalog_seeds
      WHERE status = 'published' AND common_name = $1 AND ${field} IS NOT NULL`,
    [target.common_name],
  );
  if (!row || row.ct < 1 || row.med === null) return null;
  return {
    median: Number(row.med),
    stdev: Number(row.sd ?? 0),
    count: Number(row.ct),
  };
}

async function firstUnauthorizedAt(sql: Sql, correctionId: string): Promise<number | null> {
  // We only track the latest ai_last_error in this row; for "24h
  // cumulative unauthorized" we approximate via created_at. Good
  // enough for now — proper accumulator can land in Phase 4E.
  const row = await dbGet<{ created_at: number }>(
    sql,
    `SELECT created_at FROM catalog_feedback WHERE id = $1`,
    [correctionId],
  );
  return row?.created_at ?? null;
}

const SWEEP_SENTINEL_KEY = 'corrections_audit_sweep_last_utc_day';

async function maybeSweep(sql: Sql, now: number): Promise<void> {
  // Cheap once-per-UTC-day gate using a sentinel row in a tiny table.
  // We piggyback _seedkeep_migrations to avoid a new table; key is
  // recognizable so it can't collide.
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS _seedkeep_kv (
       k TEXT PRIMARY KEY,
       v TEXT
     )`,
  );
  const today = new Date(now).toISOString().slice(0, 10);
  const row = await dbGet<{ v: string | null }>(
    sql,
    `SELECT v FROM _seedkeep_kv WHERE k = $1`,
    [SWEEP_SENTINEL_KEY],
  );
  if (row?.v === today) return;
  await sweepAuditLog(sql, now);
  await dbRun(
    sql,
    `INSERT INTO _seedkeep_kv (k, v) VALUES ($1, $2)
     ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [SWEEP_SENTINEL_KEY, today],
  );
}
