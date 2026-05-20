import { describe, it, expect } from 'vitest';
import { projectWindow } from '../projection';

describe('projectWindow', () => {
  it('returns unknown when the window is null', () => {
    const p = projectWindow({ windowStart: null, windowEnd: null }, '2026-05-20');
    expect(p.verdict).toBe('unknown');
    expect(p.dailyScores.scores).toHaveLength(60);
    expect(p.dailyScores.scores.every((s) => s === 0)).toBe(true);
  });

  it('verdict is too_early well before the window opens', () => {
    const p = projectWindow({ windowStart: '2026-06-15', windowEnd: '2026-08-01' }, '2026-05-20');
    expect(p.verdict).toBe('too_early');
  });

  it('verdict is plant_soon within 14 days of opening', () => {
    const p = projectWindow({ windowStart: '2026-05-25', windowEnd: '2026-07-01' }, '2026-05-20');
    expect(p.verdict).toBe('plant_soon');
  });

  it('verdict is plant_now in the early part of the window', () => {
    const p = projectWindow({ windowStart: '2026-05-18', windowEnd: '2026-07-01' }, '2026-05-20');
    expect(p.verdict).toBe('plant_now');
  });

  it('verdict is late in the back part of the window', () => {
    const p = projectWindow({ windowStart: '2026-04-01', windowEnd: '2026-05-25' }, '2026-05-20');
    expect(p.verdict).toBe('late');
  });

  it('verdict is too_late past the window', () => {
    const p = projectWindow({ windowStart: '2026-03-01', windowEnd: '2026-05-01' }, '2026-05-20');
    expect(p.verdict).toBe('too_late');
  });

  it('scores are 0 outside the window and ramp to 1 inside', () => {
    const p = projectWindow({ windowStart: '2026-05-20', windowEnd: '2026-09-20' }, '2026-05-20');
    expect(p.dailyScores.anchorDate).toBe('2026-05-20');
    expect(p.dailyScores.scores[0]).toBe(0);          // window edge
    expect(p.dailyScores.scores[7]).toBeCloseTo(1);   // 7 days in = full ramp
    expect(p.dailyScores.scores.every((s) => s >= 0 && s <= 1)).toBe(true);
  });

  it('short window (~6 days) peaks at 1.0 at the midpoint', () => {
    // Window: 2026-05-20 to 2026-05-26 (6-day window, midpoint = day 3)
    const p = projectWindow({ windowStart: '2026-05-20', windowEnd: '2026-05-26' }, '2026-05-20');
    // Midpoint is day 3 from anchor (today = start)
    expect(p.dailyScores.scores[3]).toBeCloseTo(1, 5);
    expect(p.dailyScores.scores.every((s) => s >= 0 && s <= 1)).toBe(true);
  });
});
