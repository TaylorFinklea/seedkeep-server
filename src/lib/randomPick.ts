/**
 * Weighted random picker for the "Random pick" feature.
 *
 * Phase 1 design: from the household's active seeds, return ONE seed with
 * a bias toward older packets. The bias keeps users using the seeds they
 * already own (older = lower expected germination = "use it before it
 * drops further") rather than constantly buying fresh.
 *
 * This file deliberately ships a uniform-random implementation as the
 * fallback. The product-shaping decision — HOW MUCH older packets are
 * favored — is captured in `pickWeightedSeed` and meant to be tuned by
 * a human, not an AI.
 *
 * Trade-offs to weigh when picking the weighting function:
 *   - LINEAR by age (e.g., weight = max(1, current_year - year_packed))
 *       Fair, gentle bias. Old seeds appear ~3x as often as new ones for
 *       3-year-old packets. Easy to reason about.
 *   - EXPONENTIAL / softmax (weight = exp(age * lambda))
 *       Steeper bias — old packets dominate. Good if the user complains
 *       "the random pick keeps showing me new seeds."
 *   - TWO-TIER (e.g., 70% from `>=2 years old`, 30% uniform across all)
 *       Predictable for users: "most of the time, I'll get an old one;
 *       sometimes a fresh one." Easiest to explain in the UI.
 *   - HARD AGE FALLBACK (only pick from oldest tier; if empty, fall back
 *       to next tier).
 *       Strict. Risks "always the same packet" feel if you have one very
 *       old seed.
 *
 * Edge cases to handle:
 *   - `year_packed` may be null. How does that compare to a packet from
 *     last year? Two options: treat null as "unknown / probably fresh"
 *     (low weight) or "unknown / could be anything" (median weight).
 *   - Tied weights or single-item arrays — must always return a seed when
 *     the input is non-empty.
 *
 * Keep the function pure and testable: no clock reads inside (`currentYear`
 * is passed in), no DB reads, no randomness source other than the optional
 * `rng` parameter.
 */

export interface SeedForPick {
  id: string;
  year_packed: number | null;
}

export type RandomFn = () => number;

const defaultRng: RandomFn = () => Math.random();

/**
 * Phase 1 policy: LINEAR by age, null treated as median.
 *
 *   weight(seed) = max(1, currentYear - year_packed)
 *   weight(seed) = 2  when year_packed is null  (treats unknown ages as
 *                                                 "probably 2 years old")
 *
 * Worked example with currentYear = 2026:
 *   year_packed = 2026 → weight 1
 *   year_packed = 2024 → weight 2
 *   year_packed = 2022 → weight 4
 *   year_packed = null → weight 2
 *
 * Pure function, deterministic given the same `rng`.
 */
export function pickWeightedSeed(
  seeds: SeedForPick[],
  currentYear: number,
  rng: RandomFn = defaultRng,
): SeedForPick | null {
  if (seeds.length === 0) return null;

  const weights = seeds.map((s) =>
    s.year_packed === null ? 2 : Math.max(1, currentYear - s.year_packed),
  );
  const total = weights.reduce((a, b) => a + b, 0);

  let target = rng() * total;
  for (let i = 0; i < seeds.length; i++) {
    target -= weights[i];
    if (target <= 0) return seeds[i];
  }
  // Floating-point safety net — should never hit with a well-behaved rng.
  return seeds[seeds.length - 1];
}
