/**
 * Phase 4D · decideCorrectionOutcome unit tests.
 *
 * Pure. Exhaustive sweep of every gate from spec §5 + §10:
 *   1. allowlist                          (auto_apply field vs free-text)
 *   2. sanity bounds on AI normalized     (in-range / out-of-range)
 *   3. AI review score                    (0.85 boundary)
 *   4. conflict                           (concurrent_conflict)
 *   5. recent apply                       (recent_change)
 *   6. OCC match                          (occ_conflict)
 *   7. delta-bound                        (delta_too_large / neighbor stats)
 *   8a. account age                       (account_too_new)
 *   8b. role-based quota                  (user_auto_apply_quota)
 *   override. user_acknowledged_bounds    → always queue
 *   auto_dismiss when review_score < 0.30 and no acknowledged
 */

import { describe, it, expect } from 'vitest';
import { decideCorrectionOutcome, type DecideInput } from '../correctionDecision';

function baseInput(over: Partial<DecideInput> = {}): DecideInput {
  return {
    fieldName: 'days_to_maturity_min',
    suggestedValueRaw: '75',
    aiNormalizedValue: 75,
    currentValue: '60',
    neighborStats: null,
    clientSeenValue: '60',
    aiReviewScore: 0.95,
    hasConflict: false,
    hasRecentApply: false,
    userAcknowledgedBounds: false,
    userAccountAgeDays: 30,
    userQuotaRemaining: 5,
    ...over,
  };
}

describe('auto_apply happy path', () => {
  it('numeric high-conf in-bounds OCC-match within-delta good-age good-quota → auto_apply', () => {
    const r = decideCorrectionOutcome(baseInput());
    expect(r.action).toBe('auto_apply');
    expect(r.normalizedValue).toBe(75);
  });

  it('review_score = 0.85 (boundary) → auto_apply', () => {
    const r = decideCorrectionOutcome(baseInput({ aiReviewScore: 0.85 }));
    expect(r.action).toBe('auto_apply');
  });

  it('review_score = 0.849999 (just under) → queue', () => {
    const r = decideCorrectionOutcome(baseInput({ aiReviewScore: 0.849 }));
    expect(r.action).toBe('queue_for_review');
    expect(r.reason).toBe('ai_review_score_below_threshold');
  });
});

describe('user_acknowledged_bounds override', () => {
  it('any signals + acknowledged → ALWAYS queue', () => {
    const r = decideCorrectionOutcome(baseInput({
      userAcknowledgedBounds: true,
    }));
    expect(r.action).toBe('queue_for_review');
    expect(r.reason).toBe('user_acknowledged_bounds');
  });

  it('acknowledged short-circuits before any other check', () => {
    const r = decideCorrectionOutcome(baseInput({
      userAcknowledgedBounds: true,
      aiReviewScore: 0,
      userQuotaRemaining: 0,
      hasConflict: true,
    }));
    expect(r.action).toBe('queue_for_review');
    expect(r.reason).toBe('user_acknowledged_bounds');
  });
});

describe('free-text fields always queue', () => {
  it('instructions high-conf → queue_for_review free_text_field', () => {
    const r = decideCorrectionOutcome(baseInput({
      fieldName: 'instructions',
      aiNormalizedValue: 'Sow directly after last frost. Thin to 4 inches.',
      aiReviewScore: 0.95,
      currentValue: 'Direct sow.',
      clientSeenValue: 'Direct sow.',
    }));
    expect(r.action).toBe('queue_for_review');
    expect(r.reason).toBe('free_text_field');
  });
});

describe('AI normalized validation', () => {
  it('AI normalized_value fails validateFieldValue → queue ai_normalized_invalid', () => {
    const r = decideCorrectionOutcome(baseInput({
      aiNormalizedValue: 999, // out of bounds for days_to_maturity_min
    }));
    expect(r.action).toBe('queue_for_review');
    expect(r.reason).toBe('ai_normalized_invalid');
  });

  it('null AI normalized + high score → queue ai_normalized_invalid', () => {
    const r = decideCorrectionOutcome(baseInput({
      aiNormalizedValue: null,
    }));
    expect(r.action).toBe('queue_for_review');
    expect(r.reason).toBe('ai_normalized_invalid');
  });

  it('null AI normalized + low score → auto_dismiss ai_low_confidence', () => {
    const r = decideCorrectionOutcome(baseInput({
      aiNormalizedValue: null,
      aiReviewScore: 0.1,
    }));
    expect(r.action).toBe('auto_dismiss');
    expect(r.reason).toBe('ai_low_confidence');
  });

  it('suspect threshold (seed_depth > 3) → queue requires_human', () => {
    const r = decideCorrectionOutcome(baseInput({
      fieldName: 'seed_depth_inches',
      aiNormalizedValue: 3.5,
      currentValue: '0.25',
      clientSeenValue: '0.25',
    }));
    expect(r.action).toBe('queue_for_review');
    expect(r.reason).toBe('requires_human');
  });
});

describe('delta-bound gate', () => {
  it('delta beyond ±50% + no neighbor stats → queue delta_too_large', () => {
    const r = decideCorrectionOutcome(baseInput({
      aiNormalizedValue: 200, // current=60 → ratio = 140/60 ≈ 2.33
      currentValue: '60',
      clientSeenValue: '60',
      neighborStats: null,
    }));
    expect(r.action).toBe('queue_for_review');
    expect(r.reason).toBe('delta_too_large');
  });

  it('delta beyond ±50% but within neighbor median ± stdev → auto_apply', () => {
    const r = decideCorrectionOutcome(baseInput({
      aiNormalizedValue: 200,
      currentValue: '60',
      clientSeenValue: '60',
      neighborStats: { median: 190, stdev: 20, count: 12 }, // 200 within [170, 210]
    }));
    expect(r.action).toBe('auto_apply');
  });

  it('delta beyond ±50% with too few neighbors → queue delta_too_large', () => {
    const r = decideCorrectionOutcome(baseInput({
      aiNormalizedValue: 200,
      currentValue: '60',
      clientSeenValue: '60',
      neighborStats: { median: 200, stdev: 5, count: 4 }, // count < 5
    }));
    expect(r.action).toBe('queue_for_review');
    expect(r.reason).toBe('delta_too_large');
  });

  it('current value null + numeric correction → queue delta_too_large', () => {
    // Without a baseline we can't compute delta, so unless neighbor stats agree
    // we route to queue.
    const r = decideCorrectionOutcome(baseInput({
      currentValue: null,
      clientSeenValue: null,
      aiNormalizedValue: 75,
      neighborStats: null,
    }));
    expect(r.action).toBe('queue_for_review');
    expect(r.reason).toBe('delta_too_large');
  });
});

describe('account age + quota gates', () => {
  it('account age 3d → queue account_too_new', () => {
    const r = decideCorrectionOutcome(baseInput({ userAccountAgeDays: 3 }));
    expect(r.action).toBe('queue_for_review');
    expect(r.reason).toBe('account_too_new');
  });

  it('quota remaining 0 → queue user_auto_apply_quota', () => {
    const r = decideCorrectionOutcome(baseInput({ userQuotaRemaining: 0 }));
    expect(r.action).toBe('queue_for_review');
    expect(r.reason).toBe('user_auto_apply_quota');
  });
});

describe('conflict / recent / OCC gates', () => {
  it('hasConflict=true → queue concurrent_conflict', () => {
    const r = decideCorrectionOutcome(baseInput({ hasConflict: true }));
    expect(r.action).toBe('queue_for_review');
    expect(r.reason).toBe('concurrent_conflict');
  });

  it('hasRecentApply=true → queue recent_change', () => {
    const r = decideCorrectionOutcome(baseInput({ hasRecentApply: true }));
    expect(r.action).toBe('queue_for_review');
    expect(r.reason).toBe('recent_change');
  });

  it('client_seen != current → queue occ_conflict', () => {
    const r = decideCorrectionOutcome(baseInput({
      currentValue: '65',
      clientSeenValue: '60',
    }));
    expect(r.action).toBe('queue_for_review');
    expect(r.reason).toBe('occ_conflict');
  });

  it("numeric OCC: Postgres scale-padded '0.50' matches client '0.5'", () => {
    const r = decideCorrectionOutcome(baseInput({
      fieldName: 'seed_depth_inches',
      suggestedValueRaw: '0.6',
      aiNormalizedValue: 0.6,
      currentValue: '0.50',
      clientSeenValue: '0.5',
    }));
    expect(r.action).toBe('auto_apply');
    expect(r.normalizedValue).toBe(0.6);
  });

  it('numeric OCC: genuinely different numbers still queue occ_conflict', () => {
    const r = decideCorrectionOutcome(baseInput({
      fieldName: 'seed_depth_inches',
      suggestedValueRaw: '0.6',
      aiNormalizedValue: 0.6,
      currentValue: '0.75',
      clientSeenValue: '0.5',
    }));
    expect(r.action).toBe('queue_for_review');
    expect(r.reason).toBe('occ_conflict');
  });

  it('numeric OCC: null client_seen vs populated current → occ_conflict', () => {
    const r = decideCorrectionOutcome(baseInput({
      fieldName: 'viability_years',
      suggestedValueRaw: '4',
      aiNormalizedValue: 4,
      currentValue: '3',
      clientSeenValue: null,
    }));
    expect(r.action).toBe('queue_for_review');
    expect(r.reason).toBe('occ_conflict');
  });

  it('numeric OCC: both null → match', () => {
    const r = decideCorrectionOutcome(baseInput({
      fieldName: 'viability_years',
      suggestedValueRaw: '4',
      aiNormalizedValue: 4,
      currentValue: null,
      clientSeenValue: null,
      neighborStats: { median: 4, stdev: 1, count: 6 },
    }));
    expect(r.action).toBe('auto_apply');
  });

  it('numeric OCC: unparseable client_seen for a numeric field → occ_conflict', () => {
    const r = decideCorrectionOutcome(baseInput({
      fieldName: 'viability_years',
      suggestedValueRaw: '4',
      aiNormalizedValue: 4,
      currentValue: '3',
      clientSeenValue: 'about three',
    }));
    expect(r.action).toBe('queue_for_review');
    expect(r.reason).toBe('occ_conflict');
  });

  it('enum field OCC stays text equality', () => {
    const r = decideCorrectionOutcome(baseInput({
      fieldName: 'sun_requirement',
      suggestedValueRaw: 'partial',
      aiNormalizedValue: 'partial',
      currentValue: 'full',
      clientSeenValue: 'shade',
    }));
    expect(r.action).toBe('queue_for_review');
    expect(r.reason).toBe('occ_conflict');
  });
});

describe('auto_dismiss', () => {
  it('review_score < 0.30 + no ack → auto_dismiss ai_low_confidence', () => {
    const r = decideCorrectionOutcome(baseInput({
      aiReviewScore: 0.1,
    }));
    expect(r.action).toBe('auto_dismiss');
    expect(r.reason).toBe('ai_low_confidence');
  });

  it('review_score < 0.30 + ack → queue (override wins)', () => {
    const r = decideCorrectionOutcome(baseInput({
      aiReviewScore: 0.1,
      userAcknowledgedBounds: true,
    }));
    expect(r.action).toBe('queue_for_review');
    expect(r.reason).toBe('user_acknowledged_bounds');
  });
});

describe('enum field happy path', () => {
  it('sun_requirement valid normalized → auto_apply', () => {
    const r = decideCorrectionOutcome({
      fieldName: 'sun_requirement',
      suggestedValueRaw: 'full',
      aiNormalizedValue: 'full',
      currentValue: 'partial',
      neighborStats: null,
      clientSeenValue: 'partial',
      aiReviewScore: 0.9,
      hasConflict: false,
      hasRecentApply: false,
      userAcknowledgedBounds: false,
      userAccountAgeDays: 30,
      userQuotaRemaining: 5,
    });
    expect(r.action).toBe('auto_apply');
    expect(r.normalizedValue).toBe('full');
  });

  it('invalid enum normalized → queue ai_normalized_invalid', () => {
    const r = decideCorrectionOutcome({
      fieldName: 'sun_requirement',
      suggestedValueRaw: 'full',
      aiNormalizedValue: 'half-day',
      currentValue: 'partial',
      neighborStats: null,
      clientSeenValue: 'partial',
      aiReviewScore: 0.9,
      hasConflict: false,
      hasRecentApply: false,
      userAcknowledgedBounds: false,
      userAccountAgeDays: 30,
      userQuotaRemaining: 5,
    });
    expect(r.action).toBe('queue_for_review');
    expect(r.reason).toBe('ai_normalized_invalid');
  });
});
