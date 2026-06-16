/**
 * Sprout assistant state-machine integration tests.
 *
 * Covers the propose → confirm / cancel / stale_proposal / wrong_state / stream_busy
 * critical path. The Anthropic streaming call is mocked at the module boundary
 * (`src/lib/assistant/anthropicStream.streamAnthropic`) so no real API key is
 * required and streams are fully deterministic.
 *
 * PRODUCTION BUG DOCUMENTED BELOW (do not fix here — test-only work):
 *
 *   `delete_seed` (and the other delete_* tools) use `SELECT *` in
 *   `previewDestructive` (executor.ts) to build the `was` snapshot, which
 *   captures extra columns such as `household_id`, `catalog_id`, `created_at`,
 *   `updated_at`, and `deleted_at`. However, `readCurrentWas` for those same
 *   tools only selects a specific subset of columns that does NOT include those
 *   extra fields. When `wasMatches` iterates over the keys in `storedWas`, any
 *   non-null key not present in `current` (e.g., `household_id`) causes
 *   `wasMatches` to return `false` → every delete confirmation is rejected with
 *   `stale_proposal` even when the row has not changed.
 *
 *   Affected tools: delete_seed, delete_bed, delete_planting_event,
 *   delete_journal_entry (all use `SELECT *` in previewDestructive).
 *   Non-affected: update_seed, update_bed, update_planting_event,
 *   update_journal_entry (use specific column lists that match readCurrentWas).
 *
 *   As a result, case 1 (confirm applies) uses update_seed instead of
 *   delete_seed, since update_seed's was/current column sets DO match and the
 *   stale check functions correctly.
 *
 * Run with:
 *   bun test tests/integration/assistantStateMachine.test.ts
 *
 * Prerequisites:
 *   - Local Postgres reachable at DATABASE_URL
 *   - Migrations applied (`bun run migrate`)
 */

import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import postgres, { type Sql } from 'postgres';
import { createApp } from '../../src/index';
import type { Env } from '../../src/env';
import type { AnthropicEvent } from '../../src/lib/assistant/anthropicStream';
import { encryptApiKey } from '../../src/lib/assistant/keyEncryption';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://seedkeep:dev-only@localhost:5432/seedkeep';

const sql: Sql = postgres(DATABASE_URL, {
  transform: { undefined: null },
  onnotice: () => { /* silence */ },
  types: {
    bigint: {
      to: 20,
      from: [20],
      serialize: (x: number | bigint) => String(x),
      parse: (x: string) => Number(x),
    },
  },
});

// ── Stable 32-byte base64 master key for all tests ────────────────────────────
// "test-assistant-state-machine-k00" is exactly 32 bytes.
const TEST_MASTER_KEY = Buffer.from('test-assistant-state-machine-k00').toString('base64');

const TEST_ENV: Env = {
  PORT: 8787,
  APP_ENV: 'development',
  DATABASE_URL,
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
  S3_BUCKET: 'test-bucket',
  S3_FORCE_PATH_STYLE: false,
  BETTER_AUTH_SECRET: 'test-better-auth-secret-1234567890',
  APPLE_CLIENT_ID: 'test-apple-client',
  APPLE_CLIENT_SECRET: 'test-apple-secret',
  ANTHROPIC_API_KEY: undefined,
  APPLE_IAP_SHARED_SECRET: undefined,
  ASSISTANT_KEY_MASTER: TEST_MASTER_KEY,
  DEFAULT_VISION_MODEL: 'claude-sonnet-4-6',
  DEFAULT_REVIEW_MODEL: 'claude-haiku-4-5-20251001',
  ADMIN_SECRET: undefined,
};

// ── Mock the Anthropic stream module ─────────────────────────────────────────
//
// We intercept `streamAnthropic` so no real Anthropic call is made.
// Each test drives a specific scenario by setting `mockScenario` before
// calling the stream endpoint. The generator yields typed AnthropicEvent
// objects identical to what a real Anthropic SSE response would produce.
//
// Mock seam: `src/routes/assistant.ts` imports `streamAnthropic` from
// `src/lib/assistant/anthropicStream`. mock.module replaces the module
// before any test imports it, so the route sees the mock generator.

type Scenario = 'simple_text' | 'delete_seed_propose' | 'update_seed_propose';

let mockScenario: Scenario = 'simple_text';
let mockToolCallId = 'mock-tc-static-id-001';
let currentSeedId = '';

mock.module('../../src/lib/assistant/anthropicStream', () => ({
  streamAnthropic: async function* (
    _config: unknown,
  ): AsyncGenerator<AnthropicEvent> {
    const msgId = 'mock-msg-' + Math.random().toString(36).slice(2, 10);

    if (mockScenario === 'simple_text') {
      yield { type: 'message_start', message: { id: msgId, model: 'mock' } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_stop' };
      return;
    }

    if (mockScenario === 'delete_seed_propose') {
      // Emits a delete_seed tool call. The orchestration loop will call
      // executeTool → status='proposed' → stream pauses.
      yield { type: 'message_start', message: { id: msgId, model: 'mock' } };
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: mockToolCallId, name: 'delete_seed', input: {} },
      };
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify({ id: currentSeedId }) },
      };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_stop' };
      return;
    }

    if (mockScenario === 'update_seed_propose') {
      // Emits an update_seed tool call. update_seed uses a specific column
      // list in both previewDestructive and readCurrentWas — the stale check
      // works correctly for this tool (unlike delete_seed; see bug note above).
      yield { type: 'message_start', message: { id: msgId, model: 'mock' } };
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: mockToolCallId, name: 'update_seed', input: {} },
      };
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ id: currentSeedId, custom_name: 'Updated Name' }),
        },
      };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_stop' };
      return;
    }
  },
}));

// ── DB helpers ─────────────────────────────────────────────────────────────

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 12)}`;
}

interface Fixture {
  userId: string;
  householdId: string;
  sessionToken: string;
}

async function seedAuthFixture(): Promise<Fixture> {
  const userId = uid('asm-user');
  const householdId = uid('asm-hh');
  const sessionId = uid('asm-sess');
  const sessionToken = uid('asm-tok');
  const now = Date.now();

  await sql.unsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'ASM User', $2, TRUE, $3, $3)`,
    [userId, `${userId}@example.invalid`, now],
  );
  await sql.unsafe(
    `INSERT INTO session (id, "expiresAt", token, "createdAt", "updatedAt",
                          "ipAddress", "userAgent", "userId")
     VALUES ($1, NOW() + INTERVAL '1 day', $2, NOW(), NOW(), NULL, NULL, $3)`,
    [sessionId, sessionToken, userId],
  );
  await sql.unsafe(
    `INSERT INTO households (id, name, created_at, updated_at)
     VALUES ($1, 'ASM Household', $2, $2)`,
    [householdId, now],
  );
  await sql.unsafe(
    `INSERT INTO memberships (household_id, user_id, role, joined_at)
     VALUES ($1, $2, 'owner', $3)`,
    [householdId, userId, now],
  );
  return { userId, householdId, sessionToken };
}

/** Insert an encrypted assistant key so the /stream route can decrypt it. */
async function seedAssistantKey(householdId: string): Promise<void> {
  const enc = encryptApiKey('sk-ant-mock-key-for-test', TEST_MASTER_KEY);
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO assistant_keys
       (household_id, provider, encrypted_key, key_iv, key_tag, created_at, updated_at)
     VALUES ($1, 'anthropic', $2, $3, $4, $5, $5)
     ON CONFLICT (household_id, provider) DO UPDATE SET
       encrypted_key = EXCLUDED.encrypted_key,
       key_iv = EXCLUDED.key_iv,
       key_tag = EXCLUDED.key_tag,
       updated_at = EXCLUDED.updated_at`,
    [householdId, enc.ciphertext, enc.iv, enc.tag, now],
  );
}

async function seedSeed(householdId: string, customName: string = 'Test Seed'): Promise<string> {
  const id = uid('asm-seed');
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO seeds (id, household_id, custom_name, state, created_at, updated_at)
     VALUES ($1, $2, $3, 'active', $4, $4)`,
    [id, householdId, customName, now],
  );
  return id;
}

async function createThread(
  app: ReturnType<typeof createApp>,
  fx: Fixture,
): Promise<string> {
  const res = await app.request(
    '/api/assistant/threads',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.sessionToken}` },
      body: JSON.stringify({ title: 'ASM test thread' }),
    },
    TEST_ENV,
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { ok: boolean; data: { thread: { id: string } } };
  expect(json.ok).toBe(true);
  return json.data.thread.id;
}

/** Parse SSE events from a Response body (text/event-stream). */
async function readSSEEvents(res: Response): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  if (!res.body) return events;
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
          try { events.push(JSON.parse(line.slice(5).trim()) as Record<string, unknown>); } catch { /* skip */ }
        }
      }
    }
  }
  return events;
}

/** Drive a POST /stream and parse the returned SSE events. */
async function driveStream(
  app: ReturnType<typeof createApp>,
  fx: Fixture,
  threadId: string,
): Promise<{ status: number; events: Array<Record<string, unknown>> }> {
  const res = await app.request(
    `/api/assistant/threads/${threadId}/stream`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.sessionToken}` },
      body: JSON.stringify({ text: 'trigger mock scenario' }),
    },
    TEST_ENV,
  );

  if (res.status !== 200) {
    return { status: res.status, events: [] };
  }

  const events = await readSSEEvents(res);
  return { status: 200, events };
}

const cleanup = {
  householdIds: new Set<string>(),
  userIds: new Set<string>(),
};

beforeAll(async () => {
  await sql`SELECT 1`;
});

afterAll(async () => {
  for (const id of cleanup.householdIds) {
    await sql.unsafe(
      `DELETE FROM assistant_tool_calls WHERE thread_id IN
         (SELECT id FROM assistant_threads WHERE household_id = $1)`,
      [id],
    ).catch(() => {});
    await sql.unsafe(
      `DELETE FROM assistant_messages WHERE thread_id IN
         (SELECT id FROM assistant_threads WHERE household_id = $1)`,
      [id],
    ).catch(() => {});
    await sql.unsafe(`DELETE FROM assistant_threads WHERE household_id = $1`, [id]).catch(() => {});
    await sql.unsafe(`DELETE FROM assistant_keys WHERE household_id = $1`, [id]).catch(() => {});
    await sql.unsafe(`DELETE FROM seeds WHERE household_id = $1`, [id]).catch(() => {});
    await sql.unsafe(`DELETE FROM memberships WHERE household_id = $1`, [id]).catch(() => {});
    await sql.unsafe(`DELETE FROM households WHERE id = $1`, [id]).catch(() => {});
  }
  for (const id of cleanup.userIds) {
    await sql.unsafe(`DELETE FROM "user" WHERE id = $1`, [id]).catch(() => {});
  }
  await sql.end({ timeout: 5 });
});

// ── Case 1: propose → confirm applies ─────────────────────────────────────────
//
// Uses update_seed (not delete_seed) because delete_seed's SELECT * in
// previewDestructive causes a spurious stale_proposal on confirm — see the
// production bug note at the top of this file. update_seed uses matching
// column lists and the stale check works correctly.
//
// Asserts: seed row updated to 'Updated Name', tool_call=succeeded,
// a tool_result message appended to the thread.

describe('assistantStateMachine: propose → confirm applies', () => {
  it('update_seed confirm: seed row updated, tool_call=succeeded, tool_result message appended', async () => {
    const fx = await seedAuthFixture();
    cleanup.householdIds.add(fx.householdId);
    cleanup.userIds.add(fx.userId);

    const seedId = await seedSeed(fx.householdId, 'OriginalName');
    currentSeedId = seedId;
    await seedAssistantKey(fx.householdId);

    const app = createApp(TEST_ENV);
    const threadId = await createThread(app, fx);

    // Drive the proposal via update_seed.
    mockScenario = 'update_seed_propose';
    mockToolCallId = uid('mock-tc');
    const { status: streamStatus, events } = await driveStream(app, fx, threadId);
    expect(streamStatus).toBe(200);

    const proposed = events.find((e) => e.type === 'proposed_change') as
      | { type: string; tool_call_id: string } | undefined;
    expect(proposed, `expected proposed_change; got: ${JSON.stringify(events)}`).toBeTruthy();
    const toolCallId = proposed!.tool_call_id;

    // Verify tool_call is 'proposed' in DB.
    const tcBefore = await sql.unsafe<Array<{ status: string }>>(
      `SELECT status FROM assistant_tool_calls WHERE id = $1`,
      [toolCallId],
    );
    expect(tcBefore[0]?.status).toBe('proposed');

    // Switch mock to simple_text so the confirm continuation produces a
    // clean "Done." response after the tool_result is fed back.
    mockScenario = 'simple_text';

    // POST confirm → SSE stream.
    const confirmRes = await app.request(
      `/api/assistant/tool_calls/${toolCallId}/confirm`,
      { method: 'POST', headers: { Authorization: `Bearer ${fx.sessionToken}` } },
      TEST_ENV,
    );
    expect(confirmRes.status).toBe(200);

    const confirmEvents = await readSSEEvents(confirmRes);
    const confirmTypes = confirmEvents.map((e) => e.type);

    // The confirm route emits tool_result first, then the LLM continuation ends with done.
    expect(confirmTypes).toContain('tool_result');
    expect(confirmTypes).toContain('done');

    // Assert the tool_result event reports status=done (the ToolExecutionResult
    // status returned by executeProposedChange on success is 'done', which is
    // what the confirm route stores in the DB and emits in the SSE event).
    const toolResultEvent = confirmEvents.find((e) => e.type === 'tool_result') as
      | { status: string } | undefined;
    expect(toolResultEvent?.status).toBe('done');

    // Assert seed name was updated.
    const seedRow = await sql.unsafe<Array<{ custom_name: string }>>(
      `SELECT custom_name FROM seeds WHERE id = $1`,
      [seedId],
    );
    expect(seedRow[0]?.custom_name).toBe('Updated Name');

    // Assert tool_call status → 'done' (the confirm route stores applyResult.status
    // which is 'done' for a successful executeProposedChange call).
    const tcAfter = await sql.unsafe<Array<{ status: string }>>(
      `SELECT status FROM assistant_tool_calls WHERE id = $1`,
      [toolCallId],
    );
    expect(tcAfter[0]?.status).toBe('done');

    // Assert a tool_result message was appended to the thread.
    const toolResultMessages = await sql.unsafe<Array<{ role: string; content_json: string }>>(
      `SELECT role, content_json FROM assistant_messages
        WHERE thread_id = $1 AND role = 'user'
        ORDER BY created_at ASC`,
      [threadId],
    );
    const toolResultMsg = toolResultMessages.find((m) => {
      try {
        const blocks = JSON.parse(m.content_json) as Array<{ type: string; tool_use_id?: string }>;
        return blocks.some((b) => b.type === 'tool_result' && b.tool_use_id === toolCallId);
      } catch { return false; }
    });
    expect(toolResultMsg, 'expected a user-role tool_result message in the thread').toBeTruthy();
  });
});

// ── Case 1b: delete_seed propose → confirm applies ────────────────────────────
//
// Verifies the previewDestructive fix: the `was` snapshot at proposal time
// uses readCurrentWas (column subset) — not SELECT * — so wasMatches sees
// identical key sets at confirm time and does NOT reject with stale_proposal.
//
// Asserts: tool_result status=done (not stale_proposal), seed row has
// deleted_at set, tool_call status=done.

describe('assistantStateMachine: delete_seed propose → confirm applies', () => {
  it('delete_seed confirm: seed row soft-deleted, tool_result=done, no stale_proposal', async () => {
    const fx = await seedAuthFixture();
    cleanup.householdIds.add(fx.householdId);
    cleanup.userIds.add(fx.userId);

    const seedId = await seedSeed(fx.householdId, 'DeleteConfirmTest Seed');
    currentSeedId = seedId;
    await seedAssistantKey(fx.householdId);

    const app = createApp(TEST_ENV);
    const threadId = await createThread(app, fx);

    // Drive the proposal via delete_seed.
    mockScenario = 'delete_seed_propose';
    mockToolCallId = uid('mock-tc');
    const { status: streamStatus, events } = await driveStream(app, fx, threadId);
    expect(streamStatus).toBe(200);

    const proposed = events.find((e) => e.type === 'proposed_change') as
      | { type: string; tool_call_id: string } | undefined;
    expect(proposed, `expected proposed_change; got: ${JSON.stringify(events)}`).toBeTruthy();
    const toolCallId = proposed!.tool_call_id;

    // Verify tool_call is 'proposed' in DB.
    const tcBefore = await sql.unsafe<Array<{ status: string }>>(
      `SELECT status FROM assistant_tool_calls WHERE id = $1`,
      [toolCallId],
    );
    expect(tcBefore[0]?.status).toBe('proposed');

    // DO NOT mutate the seed row — the row is unchanged since proposal.
    // With the old SELECT * bug this would spuriously return stale_proposal;
    // with the fix it must succeed.

    // Switch mock to simple_text so the confirm continuation produces a
    // clean "Done." response after the tool_result is fed back.
    mockScenario = 'simple_text';

    // POST confirm → SSE stream.
    const confirmRes = await app.request(
      `/api/assistant/tool_calls/${toolCallId}/confirm`,
      { method: 'POST', headers: { Authorization: `Bearer ${fx.sessionToken}` } },
      TEST_ENV,
    );
    expect(confirmRes.status).toBe(200);

    const confirmEvents = await readSSEEvents(confirmRes);

    // The confirm route emits tool_result first, then the LLM continuation ends with done.
    const toolResultEvent = confirmEvents.find((e) => e.type === 'tool_result') as
      | { status: string; result_json: string } | undefined;
    expect(
      toolResultEvent,
      `expected tool_result event; got: ${JSON.stringify(confirmEvents)}`,
    ).toBeTruthy();

    // Must be 'done', NOT 'failed' (which would carry stale_proposal).
    expect(toolResultEvent!.status).toBe('done');

    // Verify no stale_proposal in result_json.
    const resultPayload = JSON.parse(toolResultEvent!.result_json ?? 'null') as
      | { code?: string; deleted_id?: string }
      | null;
    expect((resultPayload as { code?: string } | null)?.code).not.toBe('stale_proposal');

    // Seed row must now be soft-deleted (deleted_at set).
    const seedRow = await sql.unsafe<Array<{ deleted_at: number | null }>>(
      `SELECT deleted_at FROM seeds WHERE id = $1`,
      [seedId],
    );
    expect(seedRow[0]?.deleted_at).not.toBeNull();

    // Tool call status must be 'done'.
    const tcAfter = await sql.unsafe<Array<{ status: string }>>(
      `SELECT status FROM assistant_tool_calls WHERE id = $1`,
      [toolCallId],
    );
    expect(tcAfter[0]?.status).toBe('done');
  });
});

// ── Case 2: propose → cancel: row unchanged, tool_call=cancelled ──────────────
//
// Uses delete_seed. Cancel doesn't need to apply the change so the
// delete_seed SELECT * bug doesn't affect this test.

describe('assistantStateMachine: propose → cancel no-ops', () => {
  it('cancel leaves the seed row unchanged and marks tool_call=cancelled', async () => {
    const fx = await seedAuthFixture();
    cleanup.householdIds.add(fx.householdId);
    cleanup.userIds.add(fx.userId);

    const seedId = await seedSeed(fx.householdId, 'CancelTest Seed');
    currentSeedId = seedId;
    await seedAssistantKey(fx.householdId);

    const app = createApp(TEST_ENV);
    const threadId = await createThread(app, fx);

    // Drive the proposal.
    mockScenario = 'delete_seed_propose';
    mockToolCallId = uid('mock-tc');
    const { events } = await driveStream(app, fx, threadId);

    const proposed = events.find((e) => e.type === 'proposed_change') as
      | { tool_call_id: string } | undefined;
    expect(proposed, `expected proposed_change; got: ${JSON.stringify(events)}`).toBeTruthy();
    const toolCallId = proposed!.tool_call_id;

    // Verify tool_call is 'proposed'.
    const tcBefore = await sql.unsafe<Array<{ status: string }>>(
      `SELECT status FROM assistant_tool_calls WHERE id = $1`,
      [toolCallId],
    );
    expect(tcBefore[0]?.status).toBe('proposed');

    // POST cancel.
    const cancelRes = await app.request(
      `/api/assistant/tool_calls/${toolCallId}/cancel`,
      { method: 'POST', headers: { Authorization: `Bearer ${fx.sessionToken}` } },
      TEST_ENV,
    );
    expect(cancelRes.status).toBe(200);
    const cancelJson = (await cancelRes.json()) as {
      ok: boolean;
      data: { toolCall: { status: string } };
    };
    expect(cancelJson.ok).toBe(true);
    expect(cancelJson.data.toolCall.status).toBe('cancelled');

    // Seed must NOT be soft-deleted.
    const seedRow = await sql.unsafe<Array<{ deleted_at: number | null }>>(
      `SELECT deleted_at FROM seeds WHERE id = $1`,
      [seedId],
    );
    expect(seedRow[0]?.deleted_at).toBeNull();
  });
});

// ── Case 3: stale_proposal — row mutated between propose and confirm ───────────
//
// Uses update_seed (see bug note at top: delete_seed always spuriously fails
// with stale_proposal due to SELECT * in previewDestructive, so it doesn't
// provide a meaningful test of the stale detection).
//
// Flow: propose an update, mutate the row directly via SQL, confirm → refused.

describe('assistantStateMachine: stale_proposal after row mutation', () => {
  it('confirm refused with stale_proposal when seed was changed since proposal', async () => {
    const fx = await seedAuthFixture();
    cleanup.householdIds.add(fx.householdId);
    cleanup.userIds.add(fx.userId);

    const seedId = await seedSeed(fx.householdId, 'StalePropTest Seed');
    currentSeedId = seedId;
    await seedAssistantKey(fx.householdId);

    const app = createApp(TEST_ENV);
    const threadId = await createThread(app, fx);

    // Step 1: propose an update_seed.
    mockScenario = 'update_seed_propose';
    mockToolCallId = uid('mock-tc');
    const { events } = await driveStream(app, fx, threadId);

    const proposed = events.find((e) => e.type === 'proposed_change') as
      | { tool_call_id: string } | undefined;
    expect(proposed, `expected proposed_change; got: ${JSON.stringify(events)}`).toBeTruthy();
    const toolCallId = proposed!.tool_call_id;

    // Step 2: mutate the underlying row directly (simulates another device
    // changing the seed between proposal and user's confirm tap).
    await sql.unsafe(
      `UPDATE seeds SET custom_name = 'Mutated By Other Device', updated_at = $1
         WHERE id = $2`,
      [Date.now() + 10, seedId],
    );

    // Step 3: confirm — must refuse with stale_proposal.
    mockScenario = 'simple_text';
    const confirmRes = await app.request(
      `/api/assistant/tool_calls/${toolCallId}/confirm`,
      { method: 'POST', headers: { Authorization: `Bearer ${fx.sessionToken}` } },
      TEST_ENV,
    );
    // The confirm route opens an SSE stream regardless; status 200.
    expect(confirmRes.status).toBe(200);

    const confirmEvents = await readSSEEvents(confirmRes);

    // The first emitted event is tool_result. Since executeProposedChange
    // returned stale_proposal, it should report status=failed.
    const toolResult = confirmEvents.find((e) => e.type === 'tool_result') as
      | { status: string; result_json: string } | undefined;
    expect(toolResult, `expected tool_result event; got: ${JSON.stringify(confirmEvents)}`).toBeTruthy();
    expect(toolResult!.status).toBe('failed');

    // Verify result_json contains stale_proposal error code.
    const resultPayload = JSON.parse(toolResult!.result_json) as { code?: string } | null;
    expect((resultPayload as { code?: string })?.code).toBe('stale_proposal');

    // The seed name was NOT updated to 'Updated Name' — stale check blocked it.
    const seedRow = await sql.unsafe<Array<{ custom_name: string }>>(
      `SELECT custom_name FROM seeds WHERE id = $1`,
      [seedId],
    );
    expect(seedRow[0]?.custom_name).toBe('Mutated By Other Device');

    // Tool call must NOT be succeeded.
    const tcRow = await sql.unsafe<Array<{ status: string }>>(
      `SELECT status FROM assistant_tool_calls WHERE id = $1`,
      [toolCallId],
    );
    expect(tcRow[0]?.status).not.toBe('succeeded');
  });
});

// ── Case 4: wrong_state — confirming or cancelling an already-resolved call ───

describe('assistantStateMachine: wrong_state on already-resolved tool_call', () => {
  it('confirm of already-cancelled call → 409 wrong_state (no double-apply)', async () => {
    const fx = await seedAuthFixture();
    cleanup.householdIds.add(fx.householdId);
    cleanup.userIds.add(fx.userId);

    const seedId = await seedSeed(fx.householdId, 'WrongState Seed');
    currentSeedId = seedId;
    void seedId; // not needed after proposal; cancel prevents any mutation
    await seedAssistantKey(fx.householdId);

    const app = createApp(TEST_ENV);
    const threadId = await createThread(app, fx);

    // Propose a delete.
    mockScenario = 'delete_seed_propose';
    mockToolCallId = uid('mock-tc');
    const { events } = await driveStream(app, fx, threadId);

    const proposed = events.find((e) => e.type === 'proposed_change') as
      | { tool_call_id: string } | undefined;
    expect(proposed, `expected proposed_change; got: ${JSON.stringify(events)}`).toBeTruthy();
    const toolCallId = proposed!.tool_call_id;

    // Cancel once.
    const cancelRes = await app.request(
      `/api/assistant/tool_calls/${toolCallId}/cancel`,
      { method: 'POST', headers: { Authorization: `Bearer ${fx.sessionToken}` } },
      TEST_ENV,
    );
    expect(cancelRes.status).toBe(200);

    // Attempt to confirm an already-cancelled call → 409 wrong_state.
    const confirmRes = await app.request(
      `/api/assistant/tool_calls/${toolCallId}/confirm`,
      { method: 'POST', headers: { Authorization: `Bearer ${fx.sessionToken}` } },
      TEST_ENV,
    );
    expect(confirmRes.status).toBe(409);
    const confirmJson = (await confirmRes.json()) as { ok: boolean; error: { code: string } };
    expect(confirmJson.ok).toBe(false);
    expect(confirmJson.error.code).toBe('wrong_state');
  });

  it('cancel of already-cancelled call → 409 wrong_state', async () => {
    const fx = await seedAuthFixture();
    cleanup.householdIds.add(fx.householdId);
    cleanup.userIds.add(fx.userId);

    const seedId = await seedSeed(fx.householdId, 'WrongState2 Seed');
    currentSeedId = seedId;
    void seedId;
    await seedAssistantKey(fx.householdId);

    const app = createApp(TEST_ENV);
    const threadId = await createThread(app, fx);

    // Propose.
    mockScenario = 'delete_seed_propose';
    mockToolCallId = uid('mock-tc');
    const { events } = await driveStream(app, fx, threadId);

    const proposed = events.find((e) => e.type === 'proposed_change') as
      | { tool_call_id: string } | undefined;
    expect(proposed, `expected proposed_change; got: ${JSON.stringify(events)}`).toBeTruthy();
    const toolCallId = proposed!.tool_call_id;

    // Cancel once.
    const cancelRes = await app.request(
      `/api/assistant/tool_calls/${toolCallId}/cancel`,
      { method: 'POST', headers: { Authorization: `Bearer ${fx.sessionToken}` } },
      TEST_ENV,
    );
    expect(cancelRes.status).toBe(200);

    // Cancel again → 409 wrong_state.
    const cancel2Res = await app.request(
      `/api/assistant/tool_calls/${toolCallId}/cancel`,
      { method: 'POST', headers: { Authorization: `Bearer ${fx.sessionToken}` } },
      TEST_ENV,
    );
    expect(cancel2Res.status).toBe(409);
    const cancel2Json = (await cancel2Res.json()) as { ok: boolean; error: { code: string } };
    expect(cancel2Json.ok).toBe(false);
    expect(cancel2Json.error.code).toBe('wrong_state');
  });
});

// ── Case 5: stream_busy — second concurrent stream on a locked thread ─────────
//
// A second POST /stream on the same thread while the first holds the lock
// should return 409 stream_busy. We simulate a held lock by writing
// stream_lock_at directly to the DB (within the TTL window).

describe('assistantStateMachine: stream_busy when thread lock is held', () => {
  it('second stream attempt on a locked thread returns 409 stream_busy', async () => {
    const fx = await seedAuthFixture();
    cleanup.householdIds.add(fx.householdId);
    cleanup.userIds.add(fx.userId);

    await seedAssistantKey(fx.householdId);

    const app = createApp(TEST_ENV);
    const threadId = await createThread(app, fx);

    // Simulate a held lock by writing stream_lock_at to a recent timestamp
    // (well within the 10-minute TTL so it's not treated as stale).
    const fakeLockAt = Date.now() - 1000; // 1 second ago
    await sql.unsafe(
      `UPDATE assistant_threads SET stream_lock_at = $1 WHERE id = $2`,
      [fakeLockAt, threadId],
    );

    // Attempt to stream — the lock is held, so we expect 409 stream_busy.
    const streamRes = await app.request(
      `/api/assistant/threads/${threadId}/stream`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.sessionToken}` },
        body: JSON.stringify({ text: 'should be blocked' }),
      },
      TEST_ENV,
    );
    expect(streamRes.status).toBe(409);
    const body = (await streamRes.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('stream_busy');

    // Release the lock so cleanup works cleanly.
    await sql.unsafe(
      `UPDATE assistant_threads SET stream_lock_at = NULL WHERE id = $1`,
      [threadId],
    );
  });
});
