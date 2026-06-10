import { describe, it, expect } from 'vitest';
import { buildAiPrompt, parseAiBaseline, fetchAiBaseline } from '../aiFallback';

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

type FetchLike = (input: unknown, init?: unknown) => Promise<Response>;

describe('fetchAiBaseline timeout', () => {
  it('throws on AbortError when the timeout fires before the server responds', async () => {
    // A fetch that observes the abort signal and rejects with AbortError.
    const abortAwareFetch: FetchLike = (_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        if (!signal) return; // fallback: hang
        if (signal.aborted) {
          reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }));
        }, { once: true });
      });
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = abortAwareFetch as typeof fetch;
    try {
      await expect(
        fetchAiBaseline('key', 'model',
          { commonName: 'Tomato', variety: null, instructions: null },
          { usdaZone: '7a', avgLastFrost: '04-10', avgFirstFrost: '11-01' },
          2026,
          1, // 1ms timeout
        ),
      ).rejects.toThrow(/timed out/i);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
