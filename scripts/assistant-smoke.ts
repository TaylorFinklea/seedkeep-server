/**
 * Sprout assistant smoke test — exercises every Phase 4 route end-to-end
 * against a locally-running dev server with a mocked Anthropic backend.
 *
 *   bun run scripts/assistant-smoke.ts
 *
 * Prerequisites:
 *   - Local Postgres running, migrations 0001–0012 applied.
 *   - Dev server started with:
 *       MOCK_ANTHROPIC_URL=http://localhost:14040 bun run dev
 *     The MOCK_ANTHROPIC_URL must match the port this smoke uses.
 *
 * The smoke script spawns a minimal mock Anthropic SSE server on 14040 that
 * inspects the latest user message text for a `MOCK:<scenario>` prefix and
 * returns canned events for each scenario. This keeps the smoke free of
 * real LLM cost while exercising the orchestration loop, tool calls, and
 * proposed-change pause/resume paths.
 */

import postgres from 'postgres';

const BASE_URL = 'http://localhost:8787/api';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://seedkeep:dev-only@localhost:5432/seedkeep';
const MOCK_PORT = 14040;

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method, headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  // Some routes return SSE; only parse JSON when content-type says so.
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    return { status: res.status, body: await res.json() };
  }
  return { status: res.status, body: await res.text() };
}

async function apiStreamEvents(
  method: string,
  path: string,
  opts: { token: string; body?: unknown },
): Promise<{ status: number; events: Array<Record<string, unknown>> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method, headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok || !res.body) {
    return { status: res.status, events: [] };
  }
  const events: Array<Record<string, unknown>> = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    if (done) break;
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of raw.split('\n')) {
        if (line.startsWith('data:')) {
          try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* skip */ }
        }
      }
    }
  }
  return { status: res.status, events };
}

function nanoid12(): string {
  return Math.random().toString(36).slice(2, 14).padEnd(12, '0');
}

// ─── Mock Anthropic SSE server ──────────────────────────────────────────────

function startMockAnthropic(): { stop: () => void } {
  const server = Bun.serve({
    port: MOCK_PORT,
    fetch: async (req) => {
      if (req.method !== 'POST') return new Response('only POST', { status: 405 });
      const body = await req.json().catch(() => null) as { messages?: Array<{ role: string; content: unknown }> } | null;
      const lastUserText = extractLastUserText(body);
      const scenario = (lastUserText.match(/MOCK:([\w_]+(?::[\w-]+)*)/) ?? [, ''])[1];
      const sse = sseForScenario(scenario, lastUserText, body);
      return new Response(sse, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          'Connection': 'keep-alive',
        },
      });
    },
  });
  return { stop: () => server.stop() };
}

function extractLastUserText(body: { messages?: Array<{ role: string; content: unknown }> } | null): string {
  if (!body?.messages) return '';
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const m = body.messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block && typeof block === 'object' && 'type' in block && (block as { type: string }).type === 'text') {
          return (block as { text: string }).text ?? '';
        }
      }
    }
  }
  return '';
}

function sseForScenario(scenario: string, _text: string, body: { messages?: Array<{ role: string; content: unknown }> } | null): string {
  // After a tool_result has been fed back to us, just produce a text response
  // and stop — we don't want to loop indefinitely.
  const lastMessage = body?.messages?.[body.messages.length - 1];
  const isAfterToolResult = lastMessage?.role === 'user' && Array.isArray(lastMessage.content)
    && lastMessage.content.some((b) => b && typeof b === 'object' && 'type' in b && (b as { type: string }).type === 'tool_result');
  if (isAfterToolResult) {
    return buildTextOnlySSE('mock-msg-' + nanoid12(), 'Done.');
  }

  switch (scenario) {
    case 'simple_text':
      return buildTextOnlySSE('mock-msg-' + nanoid12(), 'Hello from the mock.');
    case 'tool_use_list_seeds':
      return buildToolUseSSE('mock-msg-' + nanoid12(), 'mock-tc-' + nanoid12(),
        'list_seeds', { limit: 50 });
    case 'tool_use_invalid_args':
      return buildToolUseSSE('mock-msg-' + nanoid12(), 'mock-tc-' + nanoid12(),
        'create_planting_event', { bed_id: 'b1' });  // missing required `kind` + `planned_for`
    case 'proposed_delete':
      return buildToolUseSSE('mock-msg-' + nanoid12(), 'mock-tc-' + nanoid12(),
        'delete_seed', { id: 'seed-to-delete' });
    case 'unknown_tool':
      return buildToolUseSSE('mock-msg-' + nanoid12(), 'mock-tc-' + nanoid12(),
        'not_a_real_tool', {});
    default:
      // Default: a short text response.
      return buildTextOnlySSE('mock-msg-' + nanoid12(), 'OK (default mock).');
  }
}

function buildTextOnlySSE(messageId: string, text: string): string {
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: messageId, model: 'mock' } })}`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}`,
    '',
  ].join('\n\n');
}

function buildToolUseSSE(messageId: string, toolCallId: string, toolName: string, args: Record<string, unknown>): string {
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: messageId, model: 'mock' } })}`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolCallId, name: toolName, input: {} } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } })}`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}`,
    '',
  ].join('\n\n');
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mock = startMockAnthropic();

  const sql = postgres(DATABASE_URL, {
    transform: { undefined: null },
    onnotice: () => { /* silence */ },
  });

  const userId = `smoke-asst-user-${nanoid12()}`;
  const householdId = `smoke-asst-hh-${nanoid12()}`;
  const token = `smoke-asst-token-${nanoid12()}`;
  const sessionId = `smoke-asst-sess-${nanoid12()}`;
  const seedId = `smoke-asst-seed-${nanoid12()}`;

  let threadId = '';
  let proposedToolCallId = '';

  console.log('\n── sprout assistant smoke test ────────────────────────────────────\n');

  try {
    const now = Date.now();
    const expiresAt = now + 1000 * 60 * 60 * 24;

    await sql.unsafe(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, FALSE, $4, $4)`,
      [userId, 'Smoke Assistant User', `smoke-asst-${nanoid12()}@test.invalid`, now]);
    await sql.unsafe(
      `INSERT INTO session (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [sessionId, expiresAt, token, now, userId]);
    await sql.unsafe(
      `INSERT INTO households (id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)`,
      [householdId, 'Smoke Assistant Household', now]);
    await sql.unsafe(
      `INSERT INTO memberships (household_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)`,
      [householdId, userId, now]);
    // A seed so the proposed-delete scenario has something to operate on.
    await sql.unsafe(
      `INSERT INTO seeds (id, household_id, custom_name, state, source, created_at, updated_at)
       VALUES ('seed-to-delete', $1, 'Mock Seed', 'active', 'store', $2, $2)`,
      [householdId, now]);
    void seedId;

    // 1. PUT key
    {
      const r = await api('PUT', '/households/me/assistant_key', {
        token, body: { provider: 'anthropic', key: 'sk-ant-mock-key-1234567890' },
      });
      const b = r.body as { ok: boolean; data?: { configured: boolean } };
      check('1. PUT /me/assistant_key configures the key',
        r.status === 200 && b.ok && b.data?.configured === true);
    }

    // 2. GET key status
    {
      const r = await api('GET', '/households/me/assistant_key', { token });
      const b = r.body as { ok: boolean; data?: { providers: Array<{ provider: string; configured: boolean }> } };
      check('2. GET /me/assistant_key shows anthropic configured',
        r.status === 200 && b.ok &&
        b.data?.providers.some((p) => p.provider === 'anthropic' && p.configured) === true);
    }

    // 3. POST thread
    {
      const r = await api('POST', '/assistant/threads', { token, body: { title: 'Smoke thread' } });
      const b = r.body as { ok: boolean; data?: { thread: { id: string } } };
      threadId = b.data?.thread?.id ?? '';
      check('3. POST /assistant/threads creates a thread',
        r.status === 200 && b.ok && threadId.length > 0);
    }

    // 4. GET threads list
    {
      const r = await api('GET', '/assistant/threads', { token });
      const b = r.body as { ok: boolean; data?: { items: Array<{ id: string }> } };
      check('4. GET /assistant/threads lists the new thread',
        r.status === 200 && b.ok && b.data!.items.some((t) => t.id === threadId));
    }

    // 5. POST stream — simple text response
    {
      const r = await apiStreamEvents('POST', `/assistant/threads/${threadId}/stream`, {
        token, body: { text: 'MOCK:simple_text hi' },
      });
      const types = r.events.map((e) => e.type);
      check('5. Stream simple-text response → text_delta + done',
        r.status === 200 && types.includes('text_delta') && types.includes('done'),
        `events: ${types.join(',')}`);
    }

    // 6. POST stream — tool_use (list_seeds) auto-executes + continues
    {
      const r = await apiStreamEvents('POST', `/assistant/threads/${threadId}/stream`, {
        token, body: { text: 'MOCK:tool_use_list_seeds show me my seeds' },
      });
      const types = r.events.map((e) => e.type);
      check('6. Stream tool_use_list_seeds → tool_use_start + tool_use_done + tool_result + done',
        r.status === 200 && types.includes('tool_use_start') && types.includes('tool_result') && types.includes('done'),
        `events: ${types.join(',')}`);
    }

    // 7. POST stream — invalid tool args produce tool_result with failed status
    {
      const r = await apiStreamEvents('POST', `/assistant/threads/${threadId}/stream`, {
        token, body: { text: 'MOCK:tool_use_invalid_args' },
      });
      const toolResult = r.events.find((e) => e.type === 'tool_result') as { status?: string } | undefined;
      check('7. Invalid tool args → tool_result with status=failed',
        r.status === 200 && toolResult?.status === 'failed',
        `status: ${toolResult?.status}`);
    }

    // 8. POST stream — unknown tool → tool_result failed
    {
      const r = await apiStreamEvents('POST', `/assistant/threads/${threadId}/stream`, {
        token, body: { text: 'MOCK:unknown_tool' },
      });
      const toolResult = r.events.find((e) => e.type === 'tool_result') as { status?: string } | undefined;
      check('8. Unknown tool → tool_result with status=failed',
        r.status === 200 && toolResult?.status === 'failed');
    }

    // 9. POST stream — proposed delete → proposed_change + stream pauses
    {
      const r = await apiStreamEvents('POST', `/assistant/threads/${threadId}/stream`, {
        token, body: { text: 'MOCK:proposed_delete delete this seed' },
      });
      const types = r.events.map((e) => e.type);
      const proposed = r.events.find((e) => e.type === 'proposed_change') as { tool_call_id?: string } | undefined;
      proposedToolCallId = proposed?.tool_call_id ?? '';
      check('9. Proposed delete → proposed_change event + no `done`',
        r.status === 200 && types.includes('proposed_change') && !types.includes('done')
        && proposedToolCallId.length > 0,
        `events: ${types.join(',')}`);
    }

    // 10. Awaiting confirmation blocks further sends
    {
      const r = await api('POST', `/assistant/threads/${threadId}/stream`, {
        token, body: { text: 'another message' },
      });
      const b = r.body as { ok: boolean; error?: { code: string } };
      check('10. Send while proposal pending → 409 awaiting_confirmation',
        r.status === 409 && b.ok === false && b.error?.code === 'awaiting_confirmation');
    }

    // 11. Confirm the proposed tool call → applies + resumes
    {
      const r = await apiStreamEvents('POST', `/assistant/tool_calls/${proposedToolCallId}/confirm`, {
        token,
      });
      const types = r.events.map((e) => e.type);
      check('11. POST /tool_calls/:id/confirm → tool_result + done',
        r.status === 200 && types.includes('tool_result') && types.includes('done'),
        `events: ${types.join(',')}`);
    }

    // 12. Verify the seed was soft-deleted
    {
      const seedRow = await sql.unsafe<Array<{ deleted_at: number | null }>>(
        `SELECT deleted_at FROM seeds WHERE id = 'seed-to-delete'`, []);
      check('12. Confirmed deletion soft-deleted the seed',
        seedRow[0]?.deleted_at != null,
        `deleted_at: ${seedRow[0]?.deleted_at}`);
    }

    // 13. Cancel path: trigger a new proposal then cancel.
    let cancelToolCallId = '';
    {
      // Re-create the seed so we can propose deleting it again.
      const now2 = Date.now();
      await sql.unsafe(
        `UPDATE seeds SET deleted_at = NULL, updated_at = $1 WHERE id = 'seed-to-delete'`,
        [now2]);
      const r = await apiStreamEvents('POST', `/assistant/threads/${threadId}/stream`, {
        token, body: { text: 'MOCK:proposed_delete try delete again' },
      });
      const proposed = r.events.find((e) => e.type === 'proposed_change') as { tool_call_id?: string } | undefined;
      cancelToolCallId = proposed?.tool_call_id ?? '';
      check('13. New proposed_delete fires after seed re-activated',
        cancelToolCallId.length > 0);
    }
    {
      const r = await api('POST', `/assistant/tool_calls/${cancelToolCallId}/cancel`, { token });
      const b = r.body as { ok: boolean; data?: { toolCall: { status: string } } };
      check('14. POST /tool_calls/:id/cancel → status=cancelled',
        r.status === 200 && b.data?.toolCall.status === 'cancelled');
    }
    {
      const seedRow = await sql.unsafe<Array<{ deleted_at: number | null }>>(
        `SELECT deleted_at FROM seeds WHERE id = 'seed-to-delete'`, []);
      check('15. Cancelled proposal did NOT delete the seed',
        seedRow[0]?.deleted_at == null);
    }

    // 16. DELETE thread → soft-delete.
    {
      const r = await api('DELETE', `/assistant/threads/${threadId}`, { token });
      check('16. DELETE /assistant/threads/:id soft-deletes',
        r.status === 200);
    }
    {
      const r = await api('GET', '/assistant/threads', { token });
      const b = r.body as { ok: boolean; data?: { items: Array<{ id: string }> } };
      check('17. Soft-deleted thread hidden from feed (since=0)',
        b.data?.items.find((t) => t.id === threadId) === undefined);
    }

    // 18. DELETE key revokes
    {
      const r = await api('DELETE', '/households/me/assistant_key?provider=anthropic', { token });
      check('18. DELETE /me/assistant_key returns 200',
        r.status === 200);
    }

  } finally {
    // Cleanup — order matters for FKs.
    try {
      await sql.unsafe(`DELETE FROM assistant_tool_calls WHERE thread_id IN (SELECT id FROM assistant_threads WHERE household_id = $1)`, [householdId]);
      await sql.unsafe(`DELETE FROM assistant_messages WHERE thread_id IN (SELECT id FROM assistant_threads WHERE household_id = $1)`, [householdId]);
      await sql.unsafe(`DELETE FROM assistant_threads WHERE household_id = $1`, [householdId]);
      await sql.unsafe(`DELETE FROM assistant_keys WHERE household_id = $1`, [householdId]);
      await sql.unsafe(`DELETE FROM seeds WHERE household_id = $1`, [householdId]);
      await sql.unsafe(`DELETE FROM memberships WHERE household_id = $1`, [householdId]);
      await sql.unsafe(`DELETE FROM households WHERE id = $1`, [householdId]);
      await sql.unsafe(`DELETE FROM session WHERE id = $1`, [sessionId]);
      await sql.unsafe(`DELETE FROM "user" WHERE id = $1`, [userId]);
    } catch (err) {
      console.error('cleanup error (non-fatal):', err);
    }
    await sql.end();
    mock.stop();
  }

  console.log(`\n── ${passed}/${passed + failed} smoke checks passed ──\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
