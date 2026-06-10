/**
 * Unit tests for aiReview.ts — covers the AbortController timer behaviour
 * that was fixed in Stabilization B4 Finding 3 (timer was cleared before
 * the body read, letting a stalled body hang the worker past the zombie
 * threshold).
 */

import { describe, it, expect } from 'vitest';
import { reviewCorrection } from '../aiReview';

const BASE_ARGS = {
  apiKey: 'test-key',
  model: 'test-model',
  fieldName: 'days_to_maturity_max',
  currentValue: '80',
  suggestedValue: 90,
  catalogContext: { common_name: 'Tomato', variety: null, company: null },
};

type FetchLike = (input: unknown, init?: unknown) => Promise<Response>;

function makeOkJsonFetch(body: unknown): FetchLike {
  return async () => {
    const json = JSON.stringify(body);
    return new Response(json, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('reviewCorrection', () => {
  it('returns ok result when fetch succeeds with valid response', async () => {
    const payload = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          review_score: 0.85,
          self_confidence: 0.9,
          normalized_value: 90,
          notes: 'Reasonable maturity value.',
        }),
      }],
    };
    const result = await reviewCorrection({
      ...BASE_ARGS,
      fetchImpl: makeOkJsonFetch(payload) as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reviewScore).toBe(0.85);
    }
  });

  it('returns timeout error when AbortController fires before headers arrive', async () => {
    // Fetch that observes the abort signal and rejects with AbortError.
    const hangingFetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        if (!signal) return;
        if (signal.aborted) {
          reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }));
        }, { once: true });
      });
    const result = await reviewCorrection({
      ...BASE_ARGS,
      timeoutMs: 1, // 1ms — fires almost immediately
      fetchImpl: hangingFetch as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('timeout');
    }
  });

  it('returns a non-hanging result when body read is interrupted by abort', async () => {
    // Simulate a server that sends 200 headers immediately but whose body
    // never resolves. This is the B4 Finding 3 scenario: the old code cleared
    // the timer before res.json(), letting a stalled body hang the worker.
    // The fix keeps the timer alive through the body read. We verify the
    // function returns (rather than hanging) by wrapping in a race with a
    // timeout promise.
    const stalledBodyFetch: FetchLike = async (_url, init) => {
      const signal = (init as RequestInit | undefined)?.signal;
      const stalledBody = new ReadableStream({
        start(controller) {
          // Abort the stream when the signal fires.
          signal?.addEventListener('abort', () => controller.error(
            Object.assign(new Error('AbortError'), { name: 'AbortError' }),
          ), { once: true });
        },
      });
      return new Response(stalledBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const raceResult = await Promise.race([
      reviewCorrection({ ...BASE_ARGS, timeoutMs: 100, fetchImpl: stalledBodyFetch as typeof fetch }),
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 2000)),
    ]);
    // The function must return before the 2s sentinel — it must not hang.
    expect(raceResult).not.toBe('hung');
    if (raceResult !== 'hung') {
      expect(raceResult.ok).toBe(false);
      // parse_error or timeout are both valid — they mean the abort was observed.
      if (!raceResult.ok) {
        expect(['timeout', 'parse_error', 'network_error']).toContain(raceResult.error.kind);
      }
    }
  });

  it('returns unauthorized error on 401', async () => {
    const fetch401: FetchLike = async () => new Response('Unauthorized', { status: 401 });
    const result = await reviewCorrection({ ...BASE_ARGS, fetchImpl: fetch401 as typeof fetch });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('unauthorized');
    }
  });

  it('returns rate_limited error on 429 with Retry-After header', async () => {
    const fetch429: FetchLike = async () => new Response('Rate limited', {
      status: 429,
      headers: { 'retry-after': '30' },
    });
    const result = await reviewCorrection({ ...BASE_ARGS, fetchImpl: fetch429 as typeof fetch });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('rate_limited');
      if (result.error.kind === 'rate_limited') {
        expect(result.error.retryAfterSec).toBe(30);
      }
    }
  });
});
