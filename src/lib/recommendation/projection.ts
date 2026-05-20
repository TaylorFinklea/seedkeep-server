// Pure projection of a season-stable planting window into a
// date-relative verdict + 60-day suitability curve. No clock, no I/O —
// the caller passes `today`. Keep it that way (mirrors randomPick.ts).

export type Verdict =
  | 'too_early' | 'plant_soon' | 'plant_now' | 'late' | 'too_late' | 'unknown';

export interface WindowInput {
  windowStart: string | null; // 'YYYY-MM-DD'
  windowEnd: string | null;
}

export interface Projection {
  verdict: Verdict;
  dailyScores: { anchorDate: string; scores: number[] }; // 60 entries
}

const SCORE_DAYS = 60;
const RAMP_DAYS = 7;          // edge ramp length
const PLANT_NOW_FRACTION = 0.4; // first 40% of the window reads as "plant now"

function toDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

export function projectWindow(window: WindowInput, today: string): Projection {
  const anchor = toDate(today);

  if (!window.windowStart || !window.windowEnd) {
    return {
      verdict: 'unknown',
      dailyScores: { anchorDate: today, scores: new Array(SCORE_DAYS).fill(0) },
    };
  }

  const start = toDate(window.windowStart);
  const end = toDate(window.windowEnd);
  const windowLen = Math.max(1, daysBetween(start, end));
  const now = anchor;

  let verdict: Verdict;
  if (daysBetween(now, start) > 14) verdict = 'too_early';
  else if (now < start) verdict = 'plant_soon';
  else if (daysBetween(start, now) <= PLANT_NOW_FRACTION * windowLen) verdict = 'plant_now';
  else if (now <= end) verdict = 'late';
  else verdict = 'too_late';

  const scores: number[] = [];
  for (let i = 0; i < SCORE_DAYS; i++) {
    const day = addDays(anchor, i);
    if (day < start || day > end) {
      scores.push(0);
      continue;
    }
    const fromStart = daysBetween(start, day);
    const toEnd = daysBetween(day, end);
    const rampUp = Math.min(1, fromStart / RAMP_DAYS);
    const rampDown = Math.min(1, toEnd / RAMP_DAYS);
    scores.push(Math.min(rampUp, rampDown));
  }

  return { verdict, dailyScores: { anchorDate: today, scores } };
}
