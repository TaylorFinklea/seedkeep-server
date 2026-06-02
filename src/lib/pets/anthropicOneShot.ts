// Non-streaming Anthropic Messages API client. One call, one response —
// returns the assembled assistant `text` block(s) as a single string.
//
// Sibling of `src/lib/assistant/anthropicStream.ts`. We don't reuse that
// module because the pet spawn / departure call sites don't need SSE
// plumbing — they want a single short JSON object back and they want to
// block on it inline (mirrors the synchronous `extractions.ts` precedent).
//
// Hard 5-minute AbortSignal cap matches the streaming client; if
// Anthropic hangs, we'd rather error than wedge a Fly machine.
//
// Mock support: same env knobs as the streaming client — set
// `MOCK_ANTHROPIC_URL` to redirect or `ASSISTANT_ANTHROPIC_MOCK=1`
// (recognized by the streaming client; included here for parity though
// the URL override is the canonical knob in tests).

export interface AnthropicOneShotConfig {
  apiKey: string;
  model: string;
  system: string;
  userText: string;
  maxTokens?: number;
  /** Override base URL for testing (e.g. a mock JSON server). */
  baseUrlOverride?: string;
  /** Optional signal so callers can compose their own cancel. */
  signal?: AbortSignal;
}

const ANTHROPIC_BASE = 'https://api.anthropic.com';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Call Anthropic Messages API non-streaming. Returns the concatenated
 * text from all `text` content blocks in the response. Throws on:
 *   - Network failure
 *   - Non-2xx HTTP response
 *   - Timeout (5 min)
 *   - Missing/empty content array
 *
 * Caller is responsible for parsing the returned text (JSON validation,
 * fallback shaping, etc.).
 */
export async function anthropicOneShot(config: AnthropicOneShotConfig): Promise<string> {
  const base = config.baseUrlOverride
    ?? (process.env.MOCK_ANTHROPIC_URL && process.env.MOCK_ANTHROPIC_URL.trim())
    ?? ANTHROPIC_BASE;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  // Compose with caller-provided signal if any. We abort our own controller
  // when the outer signal aborts; this keeps the timeout cleanup uniform.
  if (config.signal) {
    if (config.signal.aborted) controller.abort();
    else {
      config.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  let res: Response;
  try {
    res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens ?? 400,
        system: config.system,
        messages: [
          { role: 'user', content: [{ type: 'text', text: config.userText }] },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if ((err as { name?: string }).name === 'AbortError') {
      throw new Error('Anthropic one-shot timed out after 5 minutes');
    }
    throw err;
  }

  if (!res.ok) {
    let errText = '';
    try { errText = await res.text(); } catch { /* noop */ }
    clearTimeout(timeoutId);
    throw new Error(`Anthropic one-shot returned ${res.status}: ${errText.slice(0, 400)}`);
  }

  let payload: { content?: Array<{ type: string; text?: string }> };
  try {
    payload = await res.json() as typeof payload;
  } catch (err) {
    clearTimeout(timeoutId);
    throw new Error(`Anthropic one-shot returned non-JSON body: ${String(err)}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!payload.content || !Array.isArray(payload.content)) {
    throw new Error('Anthropic one-shot response missing content array');
  }
  const text = payload.content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('');
  if (!text) {
    throw new Error('Anthropic one-shot response contained no text blocks');
  }
  return text;
}
