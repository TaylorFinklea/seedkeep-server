import { describe, it, expect } from 'vitest';
import { buildAiPrompt, parseAiBaseline } from '../aiFallback';

describe('buildAiPrompt', () => {
  it('includes the variety, location, and prose instructions', () => {
    const prompt = buildAiPrompt(
      { commonName: 'Tomato', variety: 'Cherokee Purple', instructions: 'Sow after frost.' },
      { usdaZone: '7a', avgLastFrost: '04-10', avgFirstFrost: '11-01' },
      2026,
    );
    expect(prompt).toContain('Cherokee Purple');
    expect(prompt).toContain('7a');
    expect(prompt).toContain('Sow after frost.');
  });
});

describe('parseAiBaseline', () => {
  it('parses a well-formed response', () => {
    const r = parseAiBaseline(JSON.stringify({
      windowStart: '2026-05-25', windowEnd: '2026-06-20',
      indoorStart: null, indoorEnd: null,
      confidence: 0.8, reasoning: 'Warm-season crop.',
    }));
    expect(r).not.toBeNull();
    expect(r!.windowStart).toBe('2026-05-25');
    expect(r!.source).toBe('ai');
  });

  it('extracts JSON wrapped in prose', () => {
    const r = parseAiBaseline('Here is the result:\n{"windowStart":"2026-05-01","windowEnd":"2026-07-01","indoorStart":null,"indoorEnd":null,"confidence":0.7,"reasoning":"x"}');
    expect(r).not.toBeNull();
    expect(r!.windowEnd).toBe('2026-07-01');
  });

  it('returns null on malformed dates', () => {
    const r = parseAiBaseline(JSON.stringify({
      windowStart: 'May 25', windowEnd: '2026-06-20',
      indoorStart: null, indoorEnd: null, confidence: 0.8, reasoning: 'x',
    }));
    expect(r).toBeNull();
  });

  it('returns null on non-JSON', () => {
    expect(parseAiBaseline('I could not determine a window.')).toBeNull();
  });
});
