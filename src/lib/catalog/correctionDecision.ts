/**
 * Phase 4D · Pure decision function for catalog corrections.
 *
 * Eight independent gates, all of which must be true for `auto_apply`.
 * No I/O, no clock, no DB — every input is passed in by the worker. This
 * keeps the decision logic trivially unit-testable and isolates the
 * load-bearing safety policy from the worker glue.
 *
 * See spec §5 for the gate list and rationale.
 */

import {
  AUTO_APPLY_FIELDS,
  validateFieldValue,
} from './fieldBounds';

export type CorrectionAction = 'auto_apply' | 'queue_for_review' | 'auto_dismiss';

export interface NeighborStats {
  median: number;
  stdev: number;
  count: number;
}

export interface DecideInput {
  fieldName: string;
  suggestedValueRaw: string;
  /** AI's normalized value — VALIDATED again before use. */
  aiNormalizedValue: string | number | null;
  /** Current published catalog value (string-encoded) — may be null. */
  currentValue: string | null;
  neighborStats: NeighborStats | null;
  /** Value the client expected (OCC). */
  clientSeenValue: string | null;
  /** Only load-bearing AI gate. */
  aiReviewScore: number;
  hasConflict: boolean;
  /** True if catalog_audit_log shows an auto_apply within 24h on same (seed, field). */
  hasRecentApply: boolean;
  /** "File anyway" — explicit opt-in for human review, short-circuits auto-apply. */
  userAcknowledgedBounds: boolean;
  userAccountAgeDays: number;
  /** From `computeUserQuota` — already factors in lifetime stats. */
  userQuotaRemaining: number;
}

export interface DecideOutput {
  action: CorrectionAction;
  normalizedValue?: string | number;
  /** Machine-readable reason code. */
  reason: string;
}

const AUTO_APPLY_SCORE_THRESHOLD = 0.85;
const AUTO_DISMISS_SCORE_THRESHOLD = 0.30;
const DELTA_RATIO_LIMIT = 0.5;
const NEIGHBOR_MIN_COUNT = 5;
const MIN_ACCOUNT_AGE_DAYS = 7;

export function decideCorrectionOutcome(input: DecideInput): DecideOutput {
  // "File anyway" — explicit opt-in for human review, before any other check.
  if (input.userAcknowledgedBounds) {
    return { action: 'queue_for_review', reason: 'user_acknowledged_bounds' };
  }

  // Free-text + unknown fields never auto-apply. We still validate; if
  // validation fails, drop to auto_dismiss (out_of_bounds / invalid_enum
  // / unknown_field). Otherwise queue for human review.
  if (!AUTO_APPLY_FIELDS.has(input.fieldName)) {
    if (input.aiNormalizedValue === null || input.aiNormalizedValue === undefined) {
      // Free-text rows can have AI return null normalized — that's fine, queue.
      return { action: 'queue_for_review', reason: 'free_text_field' };
    }
    const validated = validateFieldValue(input.fieldName, input.aiNormalizedValue);
    if (!validated.ok) {
      return { action: 'auto_dismiss', reason: validated.reason };
    }
    return {
      action: 'queue_for_review',
      reason: 'free_text_field',
      normalizedValue: validated.normalized,
    };
  }

  // Gate 1 (allowlist) already satisfied.

  // Gate 2 — sanity bounds on AI's normalized value. Closes the AI-lies TOCTOU.
  if (input.aiNormalizedValue === null || input.aiNormalizedValue === undefined) {
    // AI gave us nothing parseable. Score below auto_dismiss → dismiss; otherwise queue.
    if (input.aiReviewScore < AUTO_DISMISS_SCORE_THRESHOLD) {
      return { action: 'auto_dismiss', reason: 'ai_low_confidence' };
    }
    return { action: 'queue_for_review', reason: 'ai_normalized_invalid' };
  }
  const validated = validateFieldValue(input.fieldName, input.aiNormalizedValue);
  if (!validated.ok) {
    if (input.aiReviewScore < AUTO_DISMISS_SCORE_THRESHOLD) {
      return { action: 'auto_dismiss', reason: validated.reason };
    }
    return { action: 'queue_for_review', reason: 'ai_normalized_invalid' };
  }
  if (validated.requires_human) {
    return {
      action: 'queue_for_review',
      reason: 'requires_human',
      normalizedValue: validated.normalized,
    };
  }

  // Below auto_dismiss threshold short-circuits to dismiss (no other gates needed).
  if (input.aiReviewScore < AUTO_DISMISS_SCORE_THRESHOLD) {
    return { action: 'auto_dismiss', reason: 'ai_low_confidence' };
  }

  // Gate 3 — AI review score.
  if (input.aiReviewScore < AUTO_APPLY_SCORE_THRESHOLD) {
    return {
      action: 'queue_for_review',
      reason: 'ai_review_score_below_threshold',
      normalizedValue: validated.normalized,
    };
  }

  // Gate 4 — conflict.
  if (input.hasConflict) {
    return {
      action: 'queue_for_review',
      reason: 'concurrent_conflict',
      normalizedValue: validated.normalized,
    };
  }

  // Gate 5 — recent apply.
  if (input.hasRecentApply) {
    return {
      action: 'queue_for_review',
      reason: 'recent_change',
      normalizedValue: validated.normalized,
    };
  }

  // Gate 6 — OCC match.
  if ((input.clientSeenValue ?? '') !== (input.currentValue ?? '')) {
    return {
      action: 'queue_for_review',
      reason: 'occ_conflict',
      normalizedValue: validated.normalized,
    };
  }

  // Gate 7 — delta-bound or neighbor stats.
  if (typeof validated.normalized === 'number') {
    const newVal = validated.normalized;
    const curStr = input.currentValue;
    const curNum = curStr === null || curStr.trim().length === 0 ? null : parseFloat(curStr);
    let deltaOk = false;
    if (curNum !== null && Number.isFinite(curNum)) {
      if (curNum === 0) {
        deltaOk = newVal === 0;
      } else {
        const ratio = Math.abs(newVal - curNum) / Math.abs(curNum);
        deltaOk = ratio <= DELTA_RATIO_LIMIT;
      }
    } else {
      // Current value is null/blank — without a baseline, only neighbor stats can pass us.
      deltaOk = false;
    }
    if (!deltaOk && input.neighborStats && input.neighborStats.count >= NEIGHBOR_MIN_COUNT) {
      const { median, stdev } = input.neighborStats;
      if (newVal >= median - stdev && newVal <= median + stdev) {
        deltaOk = true;
      }
    }
    if (!deltaOk) {
      return {
        action: 'queue_for_review',
        reason: 'delta_too_large',
        normalizedValue: validated.normalized,
      };
    }
  }

  // Gate 8a — account age.
  if (input.userAccountAgeDays < MIN_ACCOUNT_AGE_DAYS) {
    return {
      action: 'queue_for_review',
      reason: 'account_too_new',
      normalizedValue: validated.normalized,
    };
  }

  // Gate 8b — role-based quota.
  if (input.userQuotaRemaining < 1) {
    return {
      action: 'queue_for_review',
      reason: 'user_auto_apply_quota',
      normalizedValue: validated.normalized,
    };
  }

  return {
    action: 'auto_apply',
    reason: 'auto_apply',
    normalizedValue: validated.normalized,
  };
}
