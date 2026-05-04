/**
 * Catalog moderation decision — turn extraction + review scores into a
 * lifecycle status.
 *
 * This file is the single point where we trade off catalog *growth speed*
 * against catalog *quality risk*. It's intentionally small, pure, and
 * meant to be tuned by a human, not an AI. Tests in
 * `src/lib/extraction/confidence.test.ts` will lock the policy.
 *
 * Trade-offs to weigh:
 *   - PUBLISH too eagerly → bad rows leak into the global catalog. Other
 *     households see them on the next scan. Damage compounds.
 *   - REVIEW too eagerly → user's review queue piles up. App feels
 *     "always asking" and the catalog growth slows.
 *   - REJECT outright → user sees an error. They have to manually enter
 *     the seed. We lose the photos as training data unless we still
 *     persist the extraction row.
 *
 * Inputs:
 *   - `selfConfidence` (0..1, may be null): vision model's own self-rating.
 *   - `reviewScore` (0..1): reviewer model's plausibility score.
 *   - `extraction`: the parsed extraction itself — useful for sanity
 *     checks (e.g., null common_name should never auto-publish).
 *
 * Output:
 *   { status: 'published' | 'pending' | 'rejected', reason?: string }
 *
 *   - `published`: catalog row goes live immediately. Other users see it.
 *   - `pending`:   catalog row created, but `status='pending'`. The user
 *                  who triggered the extraction sees it in their review
 *                  inbox; nobody else can find it via `/api/catalog/*`.
 *   - `rejected`:  no catalog row created. The extraction row is still
 *                  persisted (for future retraining). The iOS client
 *                  prompts manual entry.
 *
 * NOTE: keep this function pure. No clock, no DB, no I/O.
 */

import type { ExtractionResult } from './anthropic';

export interface ConfidenceInput {
  selfConfidence: number | null;
  reviewScore: number;
  extraction: ExtractionResult;
}

export type CatalogDecision =
  | { status: 'published'; reason?: string }
  | { status: 'pending'; reason: string }
  | { status: 'rejected'; reason: string };

/**
 * Phase 1 policy: BALANCED.
 *
 *   reject  → reviewScore < 0.30 OR all of (common_name, variety, company)
 *             are null  (no signal at all)
 *   publish → reviewScore ≥ 0.85 AND selfConfidence ≥ 0.70 AND common_name set
 *   pending → everything else (the user reviews from the iOS inbox)
 *
 * Pure function — keep it that way so tests in `confidence.test.ts` can
 * lock the lattice.
 */
export function decideCatalogStatus(input: ConfidenceInput): CatalogDecision {
  const { selfConfidence, reviewScore, extraction } = input;
  const allMainFieldsNull =
    !extraction.common_name && !extraction.variety && !extraction.company;

  if (reviewScore < 0.30 || allMainFieldsNull) {
    return {
      status: 'rejected',
      reason: `reviewScore ${reviewScore.toFixed(2)} below 0.30 or all key fields null`,
    };
  }

  if (
    reviewScore >= 0.85 &&
    (selfConfidence ?? 0) >= 0.70 &&
    !!extraction.common_name
  ) {
    return { status: 'published' };
  }

  return {
    status: 'pending',
    reason: `reviewScore ${reviewScore.toFixed(2)} / selfConfidence ${(selfConfidence ?? 0).toFixed(2)} below auto-publish threshold`,
  };
}
