/**
 * Phase 4D · Anthropic moderation call for catalog corrections.
 *
 * Mirrors the shape of `src/lib/extraction/review.ts` but adds:
 *   - A discriminated `AiReviewError` union so the worker can pick an
 *     appropriate backoff per failure mode.
 *   - 30s AbortController timeout (recommendation worker's call is
 *     synchronous; corrections call is the same shape, same budget).
 *   - Never throws — always resolves to an `AiReviewResult` so the
 *     worker can persist the result in a separate transaction before
 *     attempting `applyCorrectionOutcome`.
 */

import { buildModerationPrompt, parseModerationResponse } from './moderationPrompt';

export type AiReviewError =
  | { kind: 'unauthorized'; status: 401 }
  | { kind: 'rate_limited'; status: 429; retryAfterSec: number }
  | { kind: 'server_error'; status: number; body: string }
  | { kind: 'timeout' }
  | { kind: 'network_error'; message: string }
  | { kind: 'parse_error'; raw: string };

export type AiReviewResult =
  | {
      ok: true;
      reviewScore: number;
      selfConfidence: number;
      normalizedValue: string | number | null;
      notes: string;
      raw: unknown;
    }
  | { ok: false; error: AiReviewError };

export interface ReviewCorrectionArgs {
  apiKey: string;
  model: string;
  fieldName: string;
  currentValue: string | null;
  /** VALIDATED + NORMALIZED value, never raw user text. */
  suggestedValue: string | number;
  catalogContext: {
    common_name: string | null;
    variety: string | null;
    company: string | null;
  };
  /** Default 30000ms. */
  timeoutMs?: number;
  /** Test seam: inject a fetch implementation. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function reviewCorrection(args: ReviewCorrectionArgs): Promise<AiReviewResult> {
  const { system, user } = buildModerationPrompt({
    fieldName: args.fieldName,
    currentValue: args.currentValue,
    suggestedValue: args.suggestedValue,
    catalogContext: args.catalogContext,
  });

  const body = {
    model: args.model,
    max_tokens: 256,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const doFetch = args.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': args.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    const isAbort =
      (err as { name?: string } | null)?.name === 'AbortError' ||
      (typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'ABORT_ERR');
    if (isAbort) return { ok: false, error: { kind: 'timeout' } };
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { kind: 'network_error', message } };
  }
  clearTimeout(timer);

  if (res.status === 401) {
    return { ok: false, error: { kind: 'unauthorized', status: 401 } };
  }
  if (res.status === 429) {
    const retryHeader = res.headers.get('retry-after');
    const retryAfterSec = retryHeader ? Math.max(0, parseInt(retryHeader, 10) || 60) : 60;
    return { ok: false, error: { kind: 'rate_limited', status: 429, retryAfterSec } };
  }
  if (!res.ok) {
    const text = await safeText(res);
    return { ok: false, error: { kind: 'server_error', status: res.status, body: text } };
  }

  let raw: unknown;
  let text: string;
  try {
    raw = await res.json();
    text =
      (raw as { content?: { type: string; text?: string }[] } | null)?.content?.find(
        (c) => c.type === 'text',
      )?.text?.trim() ?? '';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { kind: 'parse_error', raw: message } };
  }

  if (text.length === 0) {
    return { ok: false, error: { kind: 'parse_error', raw: 'empty response body' } };
  }

  const parsed = parseModerationResponse(text);
  return {
    ok: true,
    reviewScore: parsed.review_score,
    selfConfidence: parsed.self_confidence,
    normalizedValue: parsed.normalized_value,
    notes: parsed.notes,
    raw,
  };
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}
