// Anthropic Messages API streaming client. Posts to /v1/messages with
// stream:true, then parses the SSE response into typed events.
//
// Pattern mirrors src/lib/recommendation/aiFallback.ts (raw fetch + headers).
// No SDK dependency — Anthropic's streaming format is stable and small.
//
// Mock support: when env `ASSISTANT_ANTHROPIC_MOCK=1` is set OR
// `MOCK_ANTHROPIC_URL` points elsewhere, the call is redirected. Used by
// scripts/assistant-smoke.ts so smoke runs don't burn tokens.

export interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'image';
  text?: string;
  // tool_use blocks
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result blocks (from prior turns)
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  // image blocks — Anthropic vision input. `source.type='base64'` + a
  // standard image MIME + the base64 bytes (no data: prefix).
  source?: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
    data: string;
  };
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicStreamConfig {
  apiKey: string;
  model: string;
  system: string;
  messages: AnthropicMessage[];
  tools: AnthropicTool[];
  maxTokens?: number;
  /** Override base URL for testing (e.g. a mock SSE server). */
  baseUrlOverride?: string;
}

// ── Stream event types ─────────────────────────────────────────────────────
//
// Anthropic's official SSE event types: message_start, content_block_start,
// content_block_delta, content_block_stop, message_delta, message_stop, error,
// ping. We parse the `event:` line + `data: <json>` and yield typed objects.

export type AnthropicEvent =
  | { type: 'message_start'; message: { id: string; model: string; usage?: AnthropicUsage } }
  | { type: 'content_block_start'; index: number; content_block: AnthropicContentBlock }
  | { type: 'content_block_delta'; index: number; delta: AnthropicDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason?: string }; usage?: AnthropicUsage }
  | { type: 'message_stop' }
  | { type: 'error'; error: { type: string; message: string } }
  | { type: 'ping' };

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export type AnthropicDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string };

// ── Public API ─────────────────────────────────────────────────────────────

const ANTHROPIC_BASE = 'https://api.anthropic.com';

/**
 * Stream a response from Anthropic's Messages API. Yields parsed SSE events.
 * Caller is responsible for assembling text/tool_use blocks from deltas and
 * dispatching tool calls.
 */
export async function* streamAnthropic(
  config: AnthropicStreamConfig,
): AsyncGenerator<AnthropicEvent> {
  const base = config.baseUrlOverride
    ?? (process.env.MOCK_ANTHROPIC_URL && process.env.MOCK_ANTHROPIC_URL.trim())
    ?? ANTHROPIC_BASE;

  // Hard cap on the request — if Anthropic hangs, we don't want the
  // Fly machine stuck indefinitely. 5 min covers normal long
  // completions with tool calls; anything past that the user retries.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000);

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
        max_tokens: config.maxTokens ?? 4096,
        system: config.system,
        messages: config.messages,
        tools: config.tools,
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if ((err as { name?: string }).name === 'AbortError') {
      throw new Error('Anthropic stream timed out after 5 minutes — try a more direct prompt or retry.');
    }
    throw err;
  }

  if (!res.ok) {
    let errText = '';
    try { errText = await res.text(); } catch { /* noop */ }
    clearTimeout(timeoutId);
    throw new Error(`Anthropic stream returned ${res.status}: ${errText.slice(0, 400)}`);
  }
  if (!res.body) {
    clearTimeout(timeoutId);
    throw new Error('Anthropic stream returned no body');
  }

  try {
    yield* parseSSE(res.body);
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── SSE parser ─────────────────────────────────────────────────────────────
//
// Anthropic emits events in standard SSE form:
//   event: <name>\n
//   data: <json>\n
//   \n
//
// We use the `event:` line as a hint and validate the `data:` JSON's
// `type` field. They always agree; we trust the JSON.

/**
 * Parse an SSE byte stream into AnthropicEvent values. Exported for tests.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<AnthropicEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) break;

      // Split on double-newline (event boundary). The trailing partial event
      // stays in the buffer for the next chunk.
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const ev = parseSingleEvent(rawEvent);
        if (ev) yield ev;
      }
    }
    // Flush any trailing event (no \n\n at EOF).
    const tail = buffer.trim();
    if (tail) {
      const ev = parseSingleEvent(tail);
      if (ev) yield ev;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSingleEvent(raw: string): AnthropicEvent | null {
  // Each event has one or more lines. We care about `data:` lines.
  // Comment lines (starting with `:`) are heartbeats — ignore.
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
    // `event:` line is informational; the JSON has its own `type` field.
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join('\n');
  try {
    return JSON.parse(payload) as AnthropicEvent;
  } catch (err) {
    // Malformed event — log to stderr (smoke + dev will see) and skip.
    console.error('[anthropicStream] failed to parse SSE data:', payload.slice(0, 200), err);
    return null;
  }
}
