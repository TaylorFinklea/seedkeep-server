import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { AppEnv } from '../index';
import { getSql } from '../db/client';
import { dbGet, dbAll, dbRun } from '../db/helpers';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { parseDeltaQuery, buildDeltaPayload } from '../lib/sync';

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
