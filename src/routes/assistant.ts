import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { AppEnv } from '../index';
import { getSql } from '../db/client';
import { dbGet, dbAll, dbRun } from '../db/helpers';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { parseDeltaQuery, buildDeltaPayload } from '../lib/sync';
import { decryptApiKey } from '../lib/assistant/keyEncryption';
import { TOOL_REGISTRY, anthropicTools, type ToolName } from '../lib/assistant/tools';
import { executeTool, executeProposedChange } from '../lib/assistant/executor';
import { streamAnthropic, type AnthropicMessage, type AnthropicContentBlock } from '../lib/assistant/anthropicStream';
import { buildSystemPrompt, type HouseholdSnapshot } from '../lib/assistant/prompt';

const auth = [requireAuth(), requireHousehold()] as const;

// ── Row types ──────────────────────────────────────────────────────────────

interface ThreadRow {
  id: string;
  household_id: string;
  title: string;
  thread_kind: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: string;
  content_json: string;
  page_context: string | null;
  model: string | null;
  usage_json: string | null;
  created_at: number;
}

interface ToolCallRow {
  id: string;
  message_id: string;
  thread_id: string;
  tool_name: string;
  args_json: string;
  status: string;
  result_json: string | null;
  proposed_change_json: string | null;
  confirmed_at: number | null;
  created_at: number;
  updated_at: number;
}

// ── DTO mapping ────────────────────────────────────────────────────────────

function threadToDto(r: ThreadRow) {
  return {
    id: r.id,
    householdId: r.household_id,
    title: r.title,
    threadKind: r.thread_kind,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

function messageToDto(r: MessageRow) {
  return {
    id: r.id,
    threadId: r.thread_id,
    role: r.role,
    contentJson: r.content_json,
    pageContext: r.page_context,
    model: r.model,
    usageJson: r.usage_json,
    createdAt: r.created_at,
  };
}

function toolCallToDto(r: ToolCallRow) {
  return {
    id: r.id,
    messageId: r.message_id,
    threadId: r.thread_id,
    toolName: r.tool_name,
    argsJson: r.args_json,
    status: r.status,
    resultJson: r.result_json,
    proposedChangeJson: r.proposed_change_json,
    confirmedAt: r.confirmed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── Routes ─────────────────────────────────────────────────────────────────

export const assistantRoutes = new Hono<AppEnv>();

// GET /api/assistant/threads?since=<ms>&limit=<n>
//
// Delta-sync friendly listing. When `since=0`, soft-deletes are hidden;
// any non-zero `since` includes deletes so clients can purge.
assistantRoutes.get('/threads', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const url = new URL(c.req.url);
  const query = parseDeltaQuery(url.searchParams);

  const wheres: string[] = ['household_id = $1', 'updated_at > $2'];
  const params: unknown[] = [householdId, query.since];
  if (query.since === 0) wheres.push('deleted_at IS NULL');

  params.push(query.limit);
  const rows = await dbAll<ThreadRow>(
    sql,
    `SELECT id, household_id, title, thread_kind, created_at, updated_at, deleted_at
       FROM assistant_threads
      WHERE ${wheres.join(' AND ')}
      ORDER BY updated_at ASC
      LIMIT $${params.length}`,
    params,
  );

  // buildDeltaPayload requires snake_case `updated_at` for the cursor; pass
  // raw rows, then map to DTOs after — matches the journal feed pattern.
  const payload = buildDeltaPayload(rows, query);
  return c.json({
    ok: true,
    data: {
      items: payload.items.map(threadToDto),
      cursor: payload.cursor,
      has_more: payload.has_more,
    },
  });
});

// POST /api/assistant/threads — create a new thread.
const CreateThreadBody = z.object({
  title: z.string().max(200).optional(),
  thread_kind: z.string().max(40).optional(),
});

assistantRoutes.post('/threads', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;

  const body = await c.req.json().catch(() => ({}));
  const parsed = CreateThreadBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: { code: 'bad_request',
      message: parsed.error.issues.map((i) => i.message).join('; ') } }, 400);
  }

  const id = nanoid();
  const now = Date.now();
  const title = parsed.data.title ?? '';
  const threadKind = parsed.data.thread_kind ?? 'chat';

  await dbRun(
    sql,
    `INSERT INTO assistant_threads
       (id, household_id, title, thread_kind, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)`,
    [id, householdId, title, threadKind, now],
  );

  const row = await dbGet<ThreadRow>(
    sql,
    `SELECT id, household_id, title, thread_kind, created_at, updated_at, deleted_at
       FROM assistant_threads WHERE id = $1`,
    [id],
  );
  return c.json({ ok: true, data: { thread: threadToDto(row!) } });
});

// GET /api/assistant/threads/:id — full thread with messages + tool calls.
assistantRoutes.get('/threads/:id', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const id = c.req.param('id');

  const thread = await dbGet<ThreadRow>(
    sql,
    `SELECT id, household_id, title, thread_kind, created_at, updated_at, deleted_at
       FROM assistant_threads WHERE id = $1 AND household_id = $2 LIMIT 1`,
    [id, householdId],
  );
  if (!thread) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'thread not found' } }, 404);
  }

  const messages = await dbAll<MessageRow>(
    sql,
    `SELECT id, thread_id, role, content_json, page_context, model, usage_json, created_at
       FROM assistant_messages WHERE thread_id = $1
      ORDER BY created_at ASC, id ASC`,
    [id],
  );

  const toolCalls = await dbAll<ToolCallRow>(
    sql,
    `SELECT id, message_id, thread_id, tool_name, args_json, status,
            result_json, proposed_change_json, confirmed_at, created_at, updated_at
       FROM assistant_tool_calls WHERE thread_id = $1
      ORDER BY created_at ASC`,
    [id],
  );

  return c.json({
    ok: true,
    data: {
      thread: threadToDto(thread),
      messages: messages.map(messageToDto),
      toolCalls: toolCalls.map(toolCallToDto),
    },
  });
});

// PATCH /api/assistant/threads/:id — update title.
const PatchThreadBody = z.object({
  title: z.string().max(200),
});

assistantRoutes.patch('/threads/:id', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = PatchThreadBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: { code: 'bad_request',
      message: parsed.error.issues.map((i) => i.message).join('; ') } }, 400);
  }

  const now = Date.now();
  await dbRun(
    sql,
    `UPDATE assistant_threads SET title = $1, updated_at = $2
       WHERE id = $3 AND household_id = $4 AND deleted_at IS NULL`,
    [parsed.data.title, now, id, householdId],
  );

  const row = await dbGet<ThreadRow>(
    sql,
    `SELECT id, household_id, title, thread_kind, created_at, updated_at, deleted_at
       FROM assistant_threads WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [id, householdId],
  );
  if (!row) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'thread not found' } }, 404);
  }
  return c.json({ ok: true, data: { thread: threadToDto(row) } });
});

// DELETE /api/assistant/threads/:id — soft-delete.
assistantRoutes.delete('/threads/:id', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const id = c.req.param('id');
  const now = Date.now();
  await dbRun(
    sql,
    `UPDATE assistant_threads SET deleted_at = $1, updated_at = $1
       WHERE id = $2 AND household_id = $3 AND deleted_at IS NULL`,
    [now, id, householdId],
  );
  return c.json({ ok: true, data: { id } });
});

// ─── Streaming endpoint + tool orchestration ───────────────────────────────
//
// POST /api/assistant/threads/:id/stream
//
// Body: { text: string, page_context?: PageContext }
// Response: text/event-stream with custom event types matching the spec
// (text_delta, tool_use_start, tool_use_done, tool_result, proposed_change,
//  done, error). Stream closes after `done` or `proposed_change`.
//
// The orchestration loop:
//   1. Persist user message; build conversation history from DB.
//   2. Call Anthropic with stream:true. Iterate parsed events.
//   3. On text deltas: forward to client + accumulate into assistant message buffer.
//   4. On tool_use blocks: validate args; if requires_confirmation, write a
//      proposed-change row + emit `proposed_change` + close stream. Else
//      execute, write tool_result block, and continue the loop with another
//      Anthropic call.
//   5. On natural stop (no pending tool call): persist final assistant message,
//      emit `done`, close stream.

const StreamBody = z.object({
  text: z.string().min(1).max(8000),
  page_context: z.object({
    pageType: z.string(),
    entityId: z.string().optional(),
    label: z.string().optional(),
  }).optional(),
});

const MAX_TURNS = 10;          // safety cap on tool-call iterations per send
const DEFAULT_MODEL = 'claude-opus-4-7';

assistantRoutes.post('/threads/:id/stream', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const threadId = c.req.param('id');

  if (!c.env.ASSISTANT_KEY_MASTER) {
    return c.json({ ok: false, error: { code: 'not_configured',
      message: 'Server is missing ASSISTANT_KEY_MASTER' } }, 503);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = StreamBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: { code: 'bad_request',
      message: parsed.error.issues.map((i) => i.message).join('; ') } }, 400);
  }

  // Verify thread + ownership.
  const thread = await dbGet<ThreadRow>(
    sql,
    `SELECT id, household_id, title, thread_kind, created_at, updated_at, deleted_at
       FROM assistant_threads
      WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [threadId, householdId],
  );
  if (!thread) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'thread not found' } }, 404);
  }

  // Reject if any tool call is still awaiting confirmation — the user needs
  // to resolve it before continuing the conversation.
  const pending = await dbGet<{ id: string }>(
    sql,
    `SELECT id FROM assistant_tool_calls
      WHERE thread_id = $1 AND status = 'proposed' LIMIT 1`,
    [threadId],
  );
  if (pending) {
    return c.json({ ok: false, error: { code: 'awaiting_confirmation',
      message: 'A previous tool call is still awaiting user confirmation' } }, 409);
  }

  // Load the encrypted Anthropic key.
  interface KeyRow { encrypted_key: Buffer; key_iv: Buffer; key_tag: Buffer }
  const keyRow = await dbGet<KeyRow>(
    sql,
    `SELECT encrypted_key, key_iv, key_tag FROM assistant_keys
      WHERE household_id = $1 AND provider = 'anthropic' LIMIT 1`,
    [householdId],
  );
  if (!keyRow) {
    return c.json({ ok: false, error: { code: 'no_assistant_key',
      message: 'Set your Anthropic API key in Settings to use Sprout' } }, 412);
  }
  let apiKey: string;
  try {
    apiKey = decryptApiKey(
      { ciphertext: keyRow.encrypted_key, iv: keyRow.key_iv, tag: keyRow.key_tag },
      c.env.ASSISTANT_KEY_MASTER,
    );
  } catch (err) {
    return c.json({ ok: false, error: { code: 'key_decrypt_failed',
      message: 'Stored API key could not be decrypted (master key rotated?). Re-enter your key in Settings.' } }, 500);
  }

  // Persist the user message.
  const userMessageId = nanoid();
  const now = Date.now();
  const userContent: AnthropicContentBlock[] = [{ type: 'text', text: parsed.data.text }];
  await dbRun(
    sql,
    `INSERT INTO assistant_messages
       (id, thread_id, role, content_json, page_context, created_at)
     VALUES ($1, $2, 'user', $3, $4, $5)`,
    [userMessageId, threadId, JSON.stringify(userContent),
      parsed.data.page_context ? JSON.stringify(parsed.data.page_context) : null, now],
  );

  // Build the household snapshot for the system prompt.
  const snapshot = await loadHouseholdSnapshot(sql, householdId);
  const systemPrompt = buildSystemPrompt(snapshot, parsed.data.page_context ?? null, new Date());

  // Build the conversation history (all prior messages + this new user message).
  const history = await loadConversationHistory(sql, threadId);
  const tools = anthropicTools();

  return streamSSE(c, async (stream) => {
    try {
      await orchestrateConversation({
        sql, householdId, threadId,
        apiKey, model: DEFAULT_MODEL, system: systemPrompt,
        messages: history, tools,
        stream,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await stream.writeSSE({
        data: JSON.stringify({ type: 'error', code: 'orchestration_error', message }),
      });
    }
  });
});

// ─── Confirm / cancel routes ───────────────────────────────────────────────

assistantRoutes.post('/tool_calls/:id/cancel', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const id = c.req.param('id');

  const tc = await dbGet<ToolCallRow>(
    sql,
    `SELECT tc.* FROM assistant_tool_calls tc
       JOIN assistant_threads t ON t.id = tc.thread_id
      WHERE tc.id = $1 AND t.household_id = $2 LIMIT 1`,
    [id, householdId],
  );
  if (!tc) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'tool call not found' } }, 404);
  }
  if (tc.status !== 'proposed') {
    return c.json({ ok: false, error: { code: 'wrong_state',
      message: `cannot cancel: status is ${tc.status}` } }, 409);
  }
  const now = Date.now();
  await dbRun(
    sql,
    `UPDATE assistant_tool_calls SET status = 'cancelled', updated_at = $1 WHERE id = $2`,
    [now, id],
  );
  const updated = await dbGet<ToolCallRow>(sql,
    `SELECT * FROM assistant_tool_calls WHERE id = $1`, [id]);
  return c.json({ ok: true, data: { toolCall: toolCallToDto(updated!) } });
});

// POST /api/assistant/tool_calls/:id/confirm
//
// Opens a NEW SSE stream that picks up the conversation after the deferred
// tool call is applied. Server runs the tool, writes the result back to the
// thread (as an assistant message with a tool_result content block), then
// kicks off another Anthropic call for the continuation.

assistantRoutes.post('/tool_calls/:id/confirm', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const id = c.req.param('id');

  if (!c.env.ASSISTANT_KEY_MASTER) {
    return c.json({ ok: false, error: { code: 'not_configured',
      message: 'Server is missing ASSISTANT_KEY_MASTER' } }, 503);
  }

  const tc = await dbGet<ToolCallRow>(
    sql,
    `SELECT tc.* FROM assistant_tool_calls tc
       JOIN assistant_threads t ON t.id = tc.thread_id
      WHERE tc.id = $1 AND t.household_id = $2 LIMIT 1`,
    [id, householdId],
  );
  if (!tc) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'tool call not found' } }, 404);
  }
  if (tc.status !== 'proposed') {
    return c.json({ ok: false, error: { code: 'wrong_state',
      message: `cannot confirm: status is ${tc.status}` } }, 409);
  }

  // Decrypt the API key.
  interface KeyRow { encrypted_key: Buffer; key_iv: Buffer; key_tag: Buffer }
  const keyRow = await dbGet<KeyRow>(sql,
    `SELECT encrypted_key, key_iv, key_tag FROM assistant_keys
      WHERE household_id = $1 AND provider = 'anthropic' LIMIT 1`,
    [householdId]);
  if (!keyRow) {
    return c.json({ ok: false, error: { code: 'no_assistant_key',
      message: 'API key was revoked between proposal and confirmation' } }, 412);
  }
  const apiKey = decryptApiKey(
    { ciphertext: keyRow.encrypted_key, iv: keyRow.key_iv, tag: keyRow.key_tag },
    c.env.ASSISTANT_KEY_MASTER,
  );

  // Apply the deferred change.
  const args = JSON.parse(tc.args_json);
  const applyResult = await executeProposedChange(tc.tool_name, args, { sql, householdId });
  const now = Date.now();
  await dbRun(sql,
    `UPDATE assistant_tool_calls
        SET status = $1, result_json = $2, confirmed_at = $3, updated_at = $3
      WHERE id = $4`,
    [applyResult.status, JSON.stringify(applyResult.result ?? applyResult.error ?? null), now, id]);

  // Build a tool_result message and append to the thread, then resume the LLM.
  const toolResultBlock: AnthropicContentBlock = {
    type: 'tool_result',
    tool_use_id: id,
    content: JSON.stringify(applyResult.result ?? applyResult.error ?? null),
    is_error: applyResult.status === 'failed' ? true : undefined,
  };
  const toolMessageId = nanoid();
  await dbRun(sql,
    `INSERT INTO assistant_messages
       (id, thread_id, role, content_json, created_at)
     VALUES ($1, $2, 'user', $3, $4)`,
    [toolMessageId, tc.thread_id, JSON.stringify([toolResultBlock]), now + 1]);

  // Resume the conversation in an SSE stream.
  const snapshot = await loadHouseholdSnapshot(sql, householdId);
  const systemPrompt = buildSystemPrompt(snapshot, null, new Date());
  const history = await loadConversationHistory(sql, tc.thread_id);
  const tools = anthropicTools();

  return streamSSE(c, async (stream) => {
    // Emit a tool_result event first so the client updates the card.
    await stream.writeSSE({
      data: JSON.stringify({
        type: 'tool_result',
        tool_call_id: id,
        status: applyResult.status,
        result_json: JSON.stringify(applyResult.result ?? applyResult.error ?? null),
      }),
    });
    try {
      await orchestrateConversation({
        sql, householdId, threadId: tc.thread_id,
        apiKey, model: DEFAULT_MODEL, system: systemPrompt,
        messages: history, tools,
        stream,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await stream.writeSSE({
        data: JSON.stringify({ type: 'error', code: 'orchestration_error', message }),
      });
    }
  });
});

// ─── Orchestration loop ────────────────────────────────────────────────────

interface OrchestrateOptions {
  sql: ReturnType<typeof getSql>;
  householdId: string;
  threadId: string;
  apiKey: string;
  model: string;
  system: string;
  messages: AnthropicMessage[];
  tools: ReturnType<typeof anthropicTools>;
  stream: {
    writeSSE: (msg: { data: string; event?: string }) => Promise<void>;
  };
}

/**
 * The streaming-tool-calling loop. Calls Anthropic repeatedly, threading
 * tool_results back into the conversation, until the LLM stops naturally
 * (no pending tool call) OR a proposed_change pauses the stream.
 */
async function orchestrateConversation(opts: OrchestrateOptions): Promise<void> {
  const { sql, householdId, threadId, apiKey, model, system, tools, stream } = opts;
  let messages = [...opts.messages];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const assistantMessageId = nanoid();
    const accumulatedBlocks: AnthropicContentBlock[] = [];
    const toolUsesPendingArgs = new Map<number, { id: string; name: string; jsonBuffer: string }>();
    let stoppedDueToTool = false;
    let pausedForProposedChange = false;
    let model_used: string | undefined;
    let usage: { input_tokens?: number; output_tokens?: number } | undefined;

    // Insert a placeholder assistant_message row now so tool_calls inserted
    // during the stream can reference it via FK. We'll UPDATE it with the
    // final content_json + model + usage at message_stop.
    const placeholderNow = Date.now();
    await dbRun(sql,
      `INSERT INTO assistant_messages
         (id, thread_id, role, content_json, created_at)
       VALUES ($1, $2, 'assistant', '[]', $3)`,
      [assistantMessageId, threadId, placeholderNow]);

    const events = streamAnthropic({ apiKey, model, system, messages, tools });

    for await (const ev of events) {
      switch (ev.type) {
        case 'message_start':
          model_used = ev.message.model;
          break;

        case 'content_block_start': {
          accumulatedBlocks[ev.index] = { ...ev.content_block };
          if (ev.content_block.type === 'tool_use') {
            const tcId = ev.content_block.id!;
            const tcName = ev.content_block.name!;
            toolUsesPendingArgs.set(ev.index, { id: tcId, name: tcName, jsonBuffer: '' });
            // Create the assistant_tool_calls row in 'running' status.
            const now = Date.now();
            await dbRun(sql,
              `INSERT INTO assistant_tool_calls
                 (id, message_id, thread_id, tool_name, args_json, status, created_at, updated_at)
               VALUES ($1, $2, $3, $4, '{}', 'running', $5, $5)`,
              [tcId, assistantMessageId, threadId, tcName, now]);
            await stream.writeSSE({
              data: JSON.stringify({
                type: 'tool_use_start',
                tool_call_id: tcId,
                message_id: assistantMessageId,
                tool_name: tcName,
              }),
            });
          }
          break;
        }

        case 'content_block_delta': {
          if (ev.delta.type === 'text_delta') {
            const block = accumulatedBlocks[ev.index];
            if (block && block.type === 'text') {
              block.text = (block.text ?? '') + ev.delta.text;
            }
            await stream.writeSSE({
              data: JSON.stringify({
                type: 'text_delta',
                message_id: assistantMessageId,
                delta: ev.delta.text,
              }),
            });
          } else if (ev.delta.type === 'input_json_delta') {
            const pending = toolUsesPendingArgs.get(ev.index);
            if (pending) {
              pending.jsonBuffer += ev.delta.partial_json;
            }
          }
          break;
        }

        case 'content_block_stop': {
          const pending = toolUsesPendingArgs.get(ev.index);
          if (pending) {
            // Tool call is now complete; parse args, validate, execute (or propose).
            let parsedArgs: unknown;
            try { parsedArgs = JSON.parse(pending.jsonBuffer || '{}'); }
            catch { parsedArgs = {}; }

            const block = accumulatedBlocks[ev.index];
            if (block && block.type === 'tool_use') {
              block.input = parsedArgs;
            }

            await stream.writeSSE({
              data: JSON.stringify({
                type: 'tool_use_done',
                tool_call_id: pending.id,
                args_json: pending.jsonBuffer || '{}',
              }),
            });

            const def = TOOL_REGISTRY[pending.name as ToolName];
            const result = await executeTool(pending.name, parsedArgs, { sql, householdId });
            const now = Date.now();

            if (result.status === 'proposed') {
              // Pause the stream — write proposed_change, close, return.
              await dbRun(sql,
                `UPDATE assistant_tool_calls
                    SET args_json = $1, status = 'proposed',
                        proposed_change_json = $2, updated_at = $3
                  WHERE id = $4`,
                [JSON.stringify(parsedArgs), JSON.stringify(result.proposed_change), now, pending.id]);
              await stream.writeSSE({
                data: JSON.stringify({
                  type: 'proposed_change',
                  tool_call_id: pending.id,
                  proposed_change_json: JSON.stringify(result.proposed_change),
                }),
              });
              pausedForProposedChange = true;
              toolUsesPendingArgs.delete(ev.index);
              break;
            }

            await dbRun(sql,
              `UPDATE assistant_tool_calls
                  SET args_json = $1, status = $2, result_json = $3, updated_at = $4
                WHERE id = $5`,
              [JSON.stringify(parsedArgs), result.status,
                JSON.stringify(result.result ?? result.error ?? null), now, pending.id]);
            await stream.writeSSE({
              data: JSON.stringify({
                type: 'tool_result',
                tool_call_id: pending.id,
                status: result.status,
                result_json: JSON.stringify(result.result ?? result.error ?? null),
              }),
            });
            toolUsesPendingArgs.delete(ev.index);
            stoppedDueToTool = true;
            // Note: confirmation flag is set in the tool registry; we're using
            // `def.requires_confirmation` indirectly via executeTool returning
            // 'proposed' status, which we already handled above. The `def`
            // lookup here is intentionally unused — left as documentation
            // that the registry drives executor behavior.
            void def;
          }
          break;
        }

        case 'message_delta':
          if (ev.usage) usage = { ...usage, ...ev.usage };
          break;

        case 'message_stop':
          break;

        case 'error':
          await stream.writeSSE({
            data: JSON.stringify({
              type: 'error', code: ev.error.type, message: ev.error.message,
            }),
          });
          // Persist what we have so far and bail.
          await persistAssistantMessage(sql, assistantMessageId, threadId,
            accumulatedBlocks, model_used, usage);
          return;

        case 'ping':
          break;
      }

      if (pausedForProposedChange) break;
    }

    // End of one Anthropic call. Persist the assistant message we just built.
    await persistAssistantMessage(sql, assistantMessageId, threadId,
      accumulatedBlocks, model_used, usage);

    if (pausedForProposedChange) {
      // The stream was paused — iOS will call /confirm or /cancel.
      // The /confirm route opens a new stream that continues from here.
      return;
    }

    if (!stoppedDueToTool) {
      // Natural stop — no tool calls pending. Emit `done` and close.
      await stream.writeSSE({
        data: JSON.stringify({ type: 'done', message_id: assistantMessageId }),
      });
      return;
    }

    // We executed tool(s) successfully. Append the assistant message (with
    // tool_use blocks) + the tool_result message(s) and call Anthropic again.
    messages.push({ role: 'assistant', content: accumulatedBlocks });
    // Collect tool_result blocks for the next user-role message.
    const toolResults: AnthropicContentBlock[] = [];
    for (const block of accumulatedBlocks) {
      if (block.type === 'tool_use') {
        const row = await dbGet<{ result_json: string | null }>(sql,
          `SELECT result_json FROM assistant_tool_calls WHERE id = $1`, [block.id]);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id!,
          content: row?.result_json ?? 'null',
        });
      }
    }
    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
    }
    // Loop and call Anthropic again with the tool result fed back in.
  }

  // Exceeded MAX_TURNS — bail with a budget error.
  await stream.writeSSE({
    data: JSON.stringify({
      type: 'error', code: 'turn_budget_exceeded',
      message: `Exceeded ${MAX_TURNS} tool-call turns in one send. Try a more direct question.`,
    }),
  });
}

async function persistAssistantMessage(
  sql: ReturnType<typeof getSql>,
  id: string,
  threadId: string,
  blocks: AnthropicContentBlock[],
  model: string | undefined,
  usage: { input_tokens?: number; output_tokens?: number } | undefined,
): Promise<void> {
  const now = Date.now();
  // The placeholder row was inserted at message-start; UPDATE with the final
  // accumulated content. Use UPSERT semantics so the function works whether
  // a placeholder exists or not (defensive).
  await dbRun(sql,
    `INSERT INTO assistant_messages
       (id, thread_id, role, content_json, model, usage_json, created_at)
     VALUES ($1, $2, 'assistant', $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       content_json = EXCLUDED.content_json,
       model        = EXCLUDED.model,
       usage_json   = EXCLUDED.usage_json`,
    [id, threadId, JSON.stringify(blocks), model ?? null,
      usage ? JSON.stringify(usage) : null, now]);
  // Bump the thread's updated_at so it surfaces in the feed.
  await dbRun(sql,
    `UPDATE assistant_threads SET updated_at = $1 WHERE id = $2`,
    [now, threadId]);
}

async function loadHouseholdSnapshot(
  sql: ReturnType<typeof getSql>,
  householdId: string,
): Promise<HouseholdSnapshot> {
  const hh = await dbGet<{
    home_zip: string | null; usda_zone: string | null;
    avg_last_frost: string | null; avg_first_frost: string | null;
    region_id: string | null;
  }>(sql,
    `SELECT home_zip, usda_zone, avg_last_frost, avg_first_frost, region_id
       FROM households WHERE id = $1 LIMIT 1`, [householdId]);
  const seedCount = await dbGet<{ n: number }>(sql,
    `SELECT count(*)::int AS n FROM seeds WHERE household_id = $1 AND deleted_at IS NULL`,
    [householdId]);
  const bedCount = await dbGet<{ n: number }>(sql,
    `SELECT count(*)::int AS n FROM beds WHERE household_id = $1 AND deleted_at IS NULL`,
    [householdId]);
  const thirtyDaysAgo = Date.now() - 30 * 86400 * 1000;
  const recentJournalEntryCount = await dbGet<{ n: number }>(sql,
    `SELECT count(*)::int AS n FROM journal_entries
      WHERE household_id = $1 AND deleted_at IS NULL AND created_at > $2`,
    [householdId, thirtyDaysAgo]);
  return {
    homeZip: hh?.home_zip ?? null,
    usdaZone: hh?.usda_zone ?? null,
    avgLastFrost: hh?.avg_last_frost ?? null,
    avgFirstFrost: hh?.avg_first_frost ?? null,
    regionId: hh?.region_id ?? null,
    seedCount: seedCount?.n ?? 0,
    bedCount: bedCount?.n ?? 0,
    recentJournalEntryCount: recentJournalEntryCount?.n ?? 0,
  };
}

async function loadConversationHistory(
  sql: ReturnType<typeof getSql>,
  threadId: string,
): Promise<AnthropicMessage[]> {
  const rows = await dbAll<{ role: string; content_json: string }>(sql,
    `SELECT role, content_json FROM assistant_messages
      WHERE thread_id = $1 ORDER BY created_at ASC, id ASC`,
    [threadId]);
  return rows.map((r) => ({
    role: (r.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
    content: JSON.parse(r.content_json) as AnthropicContentBlock[],
  }));
}

