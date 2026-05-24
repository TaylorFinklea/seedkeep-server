// Pure helpers for the year-over-year retrospective.
//
// Retrospective semantics: given an anchor MM-DD, return entries whose
// occurred_on MM-DD falls within ±3 days of the anchor. The ±3 fuzz is
// because gardeners don't journal every single day — May 24 should also
// surface a May 22 entry from a prior year if that was the closest.

const MMDD = /^\d{2}-\d{2}$/;

export function validateMmDd(anchor: string): boolean {
  if (!MMDD.test(anchor)) return false;
  const [m, d] = anchor.split('-').map((s) => parseInt(s, 10));
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  return true;
}

/**
 * Build the predicate fragment + params for a retrospective query.
 * Returns the list of MM-DD strings that fall within ±3 days of `anchor`
 * (handles month/year wrap correctly so Dec 31 ± 3 includes Jan 2-3).
 */
export function retrospectiveMmDdWindow(anchor: string): string[] {
  if (!validateMmDd(anchor)) throw new Error(`invalid MM-DD anchor: ${anchor}`);
  const [m, d] = anchor.split('-').map((s) => parseInt(s, 10));
  // Use a non-leap year as the reference so Feb 29 isn't accidentally generated.
  const base = new Date(Date.UTC(2023, m - 1, d));
  const days: string[] = [];
  for (let off = -3; off <= 3; off++) {
    const dt = new Date(base.getTime() + off * 86_400_000);
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    days.push(`${mm}-${dd}`);
  }
  return days;
}
