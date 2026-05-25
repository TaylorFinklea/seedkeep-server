# Phase 4 (Sprout) — Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the server side of Sprout — Seedkeep's BYOK AI assistant. Server-encrypted API key storage, multi-thread persistence, server-side tool execution over the user's garden data, SSE streaming, proposed-change pause/resume for destructive ops.

**Architecture:** Four new tables (`assistant_keys`, `assistant_threads`, `assistant_messages`, `assistant_tool_calls`) carry the assistant's state. A new route module (`src/routes/assistant.ts`) handles thread CRUD + a streaming endpoint that proxies to Anthropic using the household's stored encrypted key. Tools are thin wrappers around existing route handlers (create planting event, journal entry, etc.); destructive ops emit a `proposed_change` SSE event and pause the stream until the user confirms via a separate route.

**Tech Stack:** Bun, Hono, Postgres (postgres.js), Vitest, node:crypto (AES-256-GCM), raw `fetch` to `api.anthropic.com/v1/messages`. **No new runtime dependencies.**

**Spec:** `~/git/seedkeep/.docs/ai/specs/2026-05-25-phase-4-sprout-assistant-design.md`.

**Build phases covered:** spec phases 1-4 (server foundation, thread CRUD, tool registry + execution, streaming endpoint).

---

## Pattern references (read these before writing code)

The lesson from the Phase 3 plans: do **not** prescribe code blocks for codebase-derived patterns; read the existing reference and mirror it. The codebase-verified references for this plan:

| Need | Reference file | What to mirror |
|---|---|---|
| Route module shape | `src/routes/journal.ts` (Phase 3) | Per-route auth tuple `[requireAuth(), requireHousehold()]`; `c.json({ ok: true, data: ... })` envelope; `dbGet`/`dbAll`/`dbRun` with `$1` params; rowToDto camelCase mapping. |
| Migration idiom | `migrations/0011_journal.sql` | Header comment block, `IF NOT EXISTS` on every CREATE, partial indexes for `WHERE deleted_at IS NULL` active lists, DROP+ADD pattern for CHECK rebuilds. |
| Delta-sync per-resource | `src/routes/journal.ts:GET /api/journal` | `parseDeltaQuery` + `buildDeltaPayload` from `src/lib/sync.ts`; `since === 0` hides tombstones; `ORDER BY updated_at ASC`. |
| Anthropic HTTP call | `src/lib/recommendation/aiFallback.ts:fetchAiBaseline` AND `src/lib/extraction/anthropic.ts` | Raw `fetch('https://api.anthropic.com/v1/messages', ...)` with `anthropic-version: 2023-06-01` header. Streaming variant adds `stream: true` to the body — verify against Anthropic's current docs. |
| Smoke script structure | `scripts/journal-smoke.ts` AND `scripts/recommendations-smoke.ts` | postgres-direct fixture insertion, bearer-token API helper, pass/fail counters, `finally` cleanup with `smoke-*-` ID prefixes. |
| Reference assistant impl | `~/git/simmersmith/SimmerSmithKit/Sources/SimmerSmithKit/API/SimmerSmithAPIClient.swift` (client side) | Not server, but reveals the stream-event shape SimmerSmith uses on the wire. Worth reading for the SSE protocol. |

**Conventions** (verified against the codebase — follow exactly):
- IDs: `TEXT PRIMARY KEY`, generated with `nanoid` in app code.
- Timestamps: `BIGINT` ms-epoch (`Date.now()`).
- Enums: `CHECK` constraints, not Postgres `ENUM`.
- DB access: `src/db/helpers.ts` (`dbGet`/`dbAll`/`dbRun`/`dbBatch`), `$1`-style params.
- Routes: per-route middleware composition — `const auth = [requireAuth(), requireHousehold()] as const`.
- Success: `c.json({ ok: true, data: {...} })`. Error: `c.json({ ok: false, error: { code, message } }, status)`.
- Tests: pure-function Vitest under `src/**/__tests__/`. Run with `bun run test`.
- Migrations: append-only, applied via `bun run migrate`, auto-applied on Fly deploy via `release_command`.
- Per-resource sync: each entity has its own `GET /api/<resource>?since=<ms>&limit=<n>` returning `DeltaPage` shape. **No unified `/api/sync` envelope exists.**

**Plan-level decisions (refinements of the spec):**
- **Anthropic SDK: don't add it.** Use raw `fetch()` matching the existing `aiFallback.ts` + `extraction/anthropic.ts` pattern. Streaming uses `Response.body` as a `ReadableStream<Uint8Array>` and parses SSE in-place. Zero new dependencies.
- **Encryption: use `node:crypto` directly.** AES-256-GCM is in `node:crypto`'s `createCipheriv('aes-256-gcm', ...)`. No new dependencies.
- **SSE format**: standard `data: {json}\n\n` lines. Each line is a discrete event with a `type` field — the SSE `event:` header is NOT used; the event type comes from the JSON payload. This simplifies client parsing.
- **Tool-call pause is a database state, not an in-process pause.** When a destructive tool is proposed, the server writes `status='proposed'` + `proposed_change_json` and closes the SSE stream. On `POST /confirm`, the server opens a fresh stream that picks up the LLM conversation from the persisted state.

---

## File Structure

**Create:**
- `migrations/0012_assistant.sql` — 4 tables + indexes.
- `src/lib/assistant/keyEncryption.ts` — AES-256-GCM encrypt/decrypt with `ASSISTANT_KEY_MASTER`.
- `src/lib/assistant/__tests__/keyEncryption.test.ts`
- `src/lib/assistant/tools.ts` — tool registry: schemas + handlers map.
- `src/lib/assistant/__tests__/tools.test.ts`
- `src/lib/assistant/anthropicStream.ts` — raw-fetch Anthropic Messages API call + SSE parser + tool-call orchestration loop.
- `src/lib/assistant/__tests__/anthropicStream.test.ts` (with mocked fetch).
- `src/lib/assistant/prompt.ts` — Sprout persona system prompt builder.
- `src/lib/assistant/__tests__/prompt.test.ts`
- `src/routes/assistant.ts` — thread CRUD, streaming endpoint, confirm/cancel.
- `scripts/assistant-smoke.ts` — end-to-end smoke (~15 checks) against mocked Anthropic.

**Modify:**
- `src/index.ts` — mount `assistantRoutes` at `/api/assistant`.
- `src/routes/households.ts` — add `PUT/DELETE/GET /me/assistant_key` routes.
- `fly.toml` (likely no change; secret added via `fly secrets set` instead).
- `package.json` — no new runtime deps. Add a `smoke:assistant` script entry pointing at `scripts/assistant-smoke.ts` if convenient.

---

## Task 1: Migration 0012 — schema

**Files:**
- Create: `migrations/0012_assistant.sql`

- [ ] **Step 1: Write the migration file**

Use the SQL from the spec verbatim — it's already correct. Open `~/git/seedkeep/.docs/ai/specs/2026-05-25-phase-4-sprout-assistant-design.md` and copy the contents of the `migration 0012` SQL block (under "Data model — server"). Save to `migrations/0012_assistant.sql`. Add a header comment block following the migration-0011 idiom (read `migrations/0011_journal.sql`'s header for the style):

```sql
-- Migration: Phase 4 (Sprout AI assistant) foundation.
--
-- Adds four tables:
--   assistant_keys           — encrypted BYOK API keys (one per provider per household).
--   assistant_threads        — conversation threads; multi-thread; soft-delete.
--   assistant_messages       — append-only message log with Anthropic content-block JSON.
--   assistant_tool_calls     — tool invocations + status + proposed-change diffs for destructive ops.
--
-- Schema is forward-compatible: `provider` is open-string for future multi-provider;
-- `model` on messages lets future per-thread model overrides land as data, not schema.
```

- [ ] **Step 2: Apply locally**

```bash
cd /Users/tfinklea/git/seedkeep-server/.worktrees/phase-4-sprout-server
bun run migrate
```
Expected: `→ applying 0012_assistant.sql… ok` and `Applied 1 migration(s).`

- [ ] **Step 3: Verify schema**

```bash
docker exec seedkeep-db psql -U seedkeep -d seedkeep -c "\d assistant_threads" \
  -c "\d assistant_messages" -c "\d assistant_tool_calls" -c "\d assistant_keys"
```
Expected: all four tables with their indexes, CHECK constraints, and FKs visible.

- [ ] **Step 4: Run tests**

`bun run test 2>&1 | tail -3` — confirm 66/66 (baseline) still passes; no regression.

- [ ] **Step 5: Commit**

```bash
git add migrations/0012_assistant.sql
git commit -m "Add migration 0012: assistant_keys + threads + messages + tool_calls"
```

---

## Task 2: Key encryption library + tests

**Goal**: Encrypt/decrypt the user's Anthropic API key with AES-256-GCM under a server-wide master key. Pure, tested, dependency-free.

**Files:**
- Create: `src/lib/assistant/keyEncryption.ts`
- Create: `src/lib/assistant/__tests__/keyEncryption.test.ts`

- [ ] **Step 1: Write the encryption module**

Create `src/lib/assistant/keyEncryption.ts`. Use `node:crypto`'s `createCipheriv('aes-256-gcm', ...)` directly — no new dependencies. The module exports two functions:

```typescript
export interface EncryptedKey {
  ciphertext: Buffer;
  iv: Buffer;       // 12 bytes for GCM
  tag: Buffer;      // 16 bytes auth tag
}

/**
 * Encrypt a plaintext API key with AES-256-GCM under the server master key.
 * Master key comes from env `ASSISTANT_KEY_MASTER` — must be exactly 32 bytes
 * after base64-decode (use `openssl rand -base64 32` to generate).
 */
export function encryptApiKey(plaintext: string, masterKeyBase64: string): EncryptedKey;

/**
 * Decrypt a previously-encrypted API key. Throws if the auth tag fails
 * (tamper detection) or the master key has been rotated.
 */
export function decryptApiKey(encrypted: EncryptedKey, masterKeyBase64: string): string;
```

Implementation: master key is 32 bytes; each call generates a fresh 12-byte IV; tag is the final `cipher.getAuthTag()`. For decryption: re-derive cipher, set the auth tag, fail if `decipher.final()` throws. Keep it small (~30 lines).

- [ ] **Step 2: Write tests**

Create `src/lib/assistant/__tests__/keyEncryption.test.ts`. Cover:

```typescript
import { describe, it, expect } from 'vitest';
import { encryptApiKey, decryptApiKey } from '../keyEncryption';
import { randomBytes } from 'node:crypto';

const MASTER = randomBytes(32).toString('base64');

describe('keyEncryption', () => {
  it('round-trips a typical API key', () => {
    const plain = 'sk-ant-api03-' + 'x'.repeat(95);
    const enc = encryptApiKey(plain, MASTER);
    expect(decryptApiKey(enc, MASTER)).toBe(plain);
  });

  it('produces a fresh IV every call (same plaintext, different ciphertext)', () => {
    const plain = 'sk-ant-test';
    const a = encryptApiKey(plain, MASTER);
    const b = encryptApiKey(plain, MASTER);
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it('rejects tampered ciphertext', () => {
    const enc = encryptApiKey('sk-ant-x', MASTER);
    enc.ciphertext[0] ^= 0xff;
    expect(() => decryptApiKey(enc, MASTER)).toThrow();
  });

  it('rejects tampered tag', () => {
    const enc = encryptApiKey('sk-ant-x', MASTER);
    enc.tag[0] ^= 0xff;
    expect(() => decryptApiKey(enc, MASTER)).toThrow();
  });

  it('rejects wrong master key', () => {
    const enc = encryptApiKey('sk-ant-x', MASTER);
    const other = randomBytes(32).toString('base64');
    expect(() => decryptApiKey(enc, other)).toThrow();
  });

  it('rejects master key of wrong length', () => {
    expect(() => encryptApiKey('sk', 'too-short')).toThrow();
  });
});
```

- [ ] **Step 3: Run tests**

`bun run test src/lib/assistant 2>&1 | tail -5` — all 6 pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/assistant/keyEncryption.ts src/lib/assistant/__tests__/keyEncryption.test.ts
git commit -m "Add AES-256-GCM key encryption for BYOK storage"
```

---

## Task 3: Key management routes

**Goal**: `PUT/DELETE/GET /api/households/me/assistant_key` so iOS can configure + revoke the user's Anthropic key.

**Files:**
- Modify: `src/routes/households.ts`

- [ ] **Step 1: Read the existing households route file**

`head -50 src/routes/households.ts` — get a feel for how routes are organized. Find the existing `PUT /me/location` route — the new routes follow the same shape (auth tuple, body validation, db write, envelope response).

- [ ] **Step 2: Add the three new routes**

Append to `src/routes/households.ts`. Routes:

- `PUT /me/assistant_key` — body `{ provider: 'anthropic', key: string }`. Validate `provider === 'anthropic'` (the only allowed value in v1). Validate `key` is non-empty string. Encrypt via `encryptApiKey(key, env.ASSISTANT_KEY_MASTER)`. UPSERT into `assistant_keys`. Return `{ provider, configured: true }`.
- `DELETE /me/assistant_key?provider=anthropic` — `DELETE FROM assistant_keys WHERE household_id = $1 AND provider = $2`. Return `{ provider, configured: false }`.
- `GET /me/assistant_key` — return an array of configured providers: `{ providers: [{ provider: 'anthropic', configured: true, updated_at: ... }] }`. Never echoes the key back.

For the encrypt path: `bcrypt`-style "the row stores the encrypted bytes; the response says configured=true." iOS uses the GET to know what state to show in Settings.

- [ ] **Step 3: Add `ASSISTANT_KEY_MASTER` to env loading**

Modify `src/env.ts` (or wherever env is loaded — `grep -rln "loadEnv\|process.env.ANTHROPIC" src/ | head -3`). Add the new var. It's required when an assistant key is ever stored; for v1 we can require it always so the server fails fast if it's missing in prod:

```typescript
ASSISTANT_KEY_MASTER: z.string().min(44, 'base64-encoded 32-byte key'),
```

For local dev, set it in `.env.example` and `.env`: `ASSISTANT_KEY_MASTER="$(openssl rand -base64 32)"`. Document in the README too.

- [ ] **Step 4: Typecheck + tests**

```bash
bun run typecheck
bun run test 2>&1 | tail -3
```
Both green.

- [ ] **Step 5: Manual smoke**

In one terminal: `bun run dev`. In another: `curl -i http://localhost:8787/api/households/me/assistant_key` — expect 401 (unauthed but route exists).

- [ ] **Step 6: Commit**

```bash
git add src/routes/households.ts src/env.ts .env.example
git commit -m "Add assistant_key PUT/DELETE/GET routes for BYOK storage"
```

---

## Task 4: Thread CRUD routes + sync envelope extension

**Goal**: Multi-thread persistence with delta-sync-friendly listing. Modeled on `src/routes/journal.ts` Phase 3.

**Files:**
- Create: `src/routes/assistant.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Scaffold the route file**

Create `src/routes/assistant.ts`. The first commit covers four routes:

- `GET /api/assistant/threads?since=&limit=` — delta-sync feed. Mirror `journal.ts:GET /api/journal` exactly: `parseDeltaQuery` + `buildDeltaPayload`; `since === 0` hides tombstones; ORDER BY `updated_at ASC`.
- `POST /api/assistant/threads` — create. Body `{ title?: string, thread_kind?: string }`. Defaults: title `''`, thread_kind `'chat'`.
- `GET /api/assistant/threads/:id` — full thread with messages + tool calls. Return `{ thread, messages: [...], tool_calls: [...] }`. ORDER messages ASC by created_at; ORDER tool_calls ASC by created_at within each thread.
- `DELETE /api/assistant/threads/:id` — soft-delete. Set `deleted_at` + `updated_at` to `Date.now()`.
- `PATCH /api/assistant/threads/:id` — update title only (for v1 — future patches may expand). Body `{ title: string }`.

The streaming endpoint + tool-call confirmation routes come in later tasks; **leave them out of this commit**.

DTO shape: camelCase, mirror `journal.ts:rowToDto`. Required DTO fields:
- Thread: `id, householdId, title, threadKind, createdAt, updatedAt, deletedAt`
- Message: `id, threadId, role, contentJson, pageContext, model, usageJson, createdAt`
- ToolCall: `id, messageId, threadId, toolName, argsJson, status, resultJson, proposedChangeJson, confirmedAt, createdAt, updatedAt`

Use `nanoid()` for new IDs.

- [ ] **Step 2: Mount in `src/index.ts`**

After the existing `app.route('/api/journal', journalRoutes);` line, add:

```typescript
import { assistantRoutes } from './routes/assistant';
// ...
app.route('/api/assistant', assistantRoutes);
```

- [ ] **Step 3: Typecheck**

`bun run typecheck` — must be clean.

- [ ] **Step 4: Manual smoke**

`bun run dev` → `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/api/assistant/threads` → expect 401.

- [ ] **Step 5: Commit**

```bash
git add src/routes/assistant.ts src/index.ts
git commit -m "Add assistant thread CRUD routes (list, create, get, update, soft-delete)"
```

---

## Task 5: Tool registry — definitions + JSON-schema validation

**Goal**: Define every tool the LLM can call. Pure, tested, no DB code yet (Task 6 wires the handlers).

**Files:**
- Create: `src/lib/assistant/tools.ts`
- Create: `src/lib/assistant/__tests__/tools.test.ts`

- [ ] **Step 1: Write the tool registry module**

`src/lib/assistant/tools.ts` exports:

```typescript
export type ToolName =
  // read
  | 'list_seeds' | 'get_seed'
  | 'list_beds' | 'get_bed'
  | 'list_planting_events' | 'get_planting_event'
  | 'list_journal_entries' | 'get_journal_entry'
  | 'get_recommendation' | 'search_catalog'
  | 'get_household_location'
  // write (auto-execute)
  | 'create_planting_event' | 'create_journal_entry'
  | 'add_checklist_item' | 'toggle_checklist_item'
  // write (require proposed-change confirmation)
  | 'update_planting_event' | 'update_journal_entry'
  | 'update_seed' | 'update_bed'
  | 'delete_planting_event' | 'delete_journal_entry'
  | 'delete_seed' | 'delete_bed'
  | 'set_household_location';

export interface ToolDef {
  name: ToolName;
  description: string;             // shown to the LLM
  input_schema: Record<string, unknown>;  // JSON Schema
  requires_confirmation: boolean;  // proposed-change pause
}

export const TOOL_REGISTRY: Record<ToolName, ToolDef> = { /* ... */ };

/** Validate a tool call's args against the registered schema. */
export function validateToolArgs(name: ToolName, args: unknown):
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; reason: string };

/** Anthropic-shape tool definitions for the API call. */
export function anthropicTools(): Array<{ name: string; description: string; input_schema: object }>;
```

Fill in the registry following the spec's "Tool surface (v1)" section. Each tool gets a JSON Schema. For example:

```typescript
list_seeds: {
  name: 'list_seeds',
  description: 'List seeds in the user\'s inventory, optionally filtered by state, location, or text search.',
  input_schema: {
    type: 'object',
    properties: {
      state: { type: 'string', enum: ['active', 'wishlist', 'saved', 'archived'] },
      location_id: { type: 'string' },
      search: { type: 'string' },
      limit: { type: 'number', minimum: 1, maximum: 200, default: 50 },
    },
    additionalProperties: false,
  },
  requires_confirmation: false,
},
```

For validation: use a tiny inline JSON-schema validator (write one — schema is small enough to hand-validate property types + enums + required fields) OR use `zod` (already a dep) and translate each tool's schema to a `z.object({...})`. Zod is simpler and already imported elsewhere. **Recommend zod.**

- [ ] **Step 2: Write tests**

`src/lib/assistant/__tests__/tools.test.ts` — cover:

```typescript
describe('TOOL_REGISTRY', () => {
  it('every tool has a name, description, schema, and confirmation flag', () => {
    for (const [name, def] of Object.entries(TOOL_REGISTRY)) {
      expect(def.name).toBe(name);
      expect(def.description.length).toBeGreaterThan(10);
      expect(def.input_schema).toBeDefined();
      expect(typeof def.requires_confirmation).toBe('boolean');
    }
  });

  it('marks correct tools as requiring confirmation', () => {
    // All update_*, delete_*, and set_household_location require confirmation
    const confirmRequired = ['update_planting_event', 'update_journal_entry', 'update_seed',
      'update_bed', 'delete_planting_event', 'delete_journal_entry', 'delete_seed', 'delete_bed',
      'set_household_location'];
    for (const name of confirmRequired) {
      expect(TOOL_REGISTRY[name].requires_confirmation).toBe(true);
    }
    // Creates + reads auto-execute
    expect(TOOL_REGISTRY.create_planting_event.requires_confirmation).toBe(false);
    expect(TOOL_REGISTRY.list_seeds.requires_confirmation).toBe(false);
  });
});

describe('validateToolArgs', () => {
  it('accepts valid args', () => {
    const r = validateToolArgs('create_planting_event', {
      bed_id: 'b1', kind: 'sowing', planned_for: '2026-06-01',
    });
    expect(r.ok).toBe(true);
  });

  it('rejects missing required field', () => {
    const r = validateToolArgs('create_planting_event', { bed_id: 'b1' });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown field', () => {
    const r = validateToolArgs('list_seeds', { unknown: 'x' });
    expect(r.ok).toBe(false);
  });

  it('rejects bad enum value', () => {
    const r = validateToolArgs('create_planting_event', {
      bed_id: 'b1', kind: 'invalid', planned_for: '2026-06-01',
    });
    expect(r.ok).toBe(false);
  });

  it('rejects bad date format', () => {
    const r = validateToolArgs('create_planting_event', {
      bed_id: 'b1', kind: 'sowing', planned_for: '2026/06/01',
    });
    expect(r.ok).toBe(false);
  });
});

describe('anthropicTools', () => {
  it('returns tools shaped for the Anthropic API', () => {
    const tools = anthropicTools();
    expect(tools.length).toBe(Object.keys(TOOL_REGISTRY).length);
    for (const t of tools) {
      expect(t.name).toBeDefined();
      expect(t.description).toBeDefined();
      expect(t.input_schema).toBeDefined();
    }
  });
});
```

- [ ] **Step 3: Run tests**

`bun run test src/lib/assistant 2>&1 | tail -5` — all passing.

- [ ] **Step 4: Commit**

```bash
git add src/lib/assistant/tools.ts src/lib/assistant/__tests__/tools.test.ts
git commit -m "Add assistant tool registry: 24 tools with zod-validated schemas"
```

---

## Task 6: Tool executor — server-side handler dispatch

**Goal**: Map each tool name to a server-side handler that performs the actual DB operation. Handlers are thin wrappers over existing route logic.

**Files:**
- Create: `src/lib/assistant/executor.ts`
- Create: `src/lib/assistant/__tests__/executor.test.ts`

- [ ] **Step 1: Read existing route handlers**

Before writing the executor, read each of these to understand the underlying create/read/update/delete code paths the tools wrap:
- `src/routes/seeds.ts` — seed CRUD
- `src/routes/beds.ts` — bed CRUD
- `src/routes/planting-events.ts` — planting event CRUD
- `src/routes/journal.ts` — journal entry + checklist CRUD
- `src/routes/recommendations.ts` — recommendation lookup
- `src/routes/households.ts` — household location

Look for shared helpers (likely there are `dbGet`-driven query helpers and `dbRun`-driven mutation helpers). The executor should call these — not duplicate the SQL.

- [ ] **Step 2: Write the executor module**

`src/lib/assistant/executor.ts` exports:

```typescript
export interface ToolExecutionContext {
  sql: ReturnType<typeof getSql>;
  householdId: string;
}

export interface ToolExecutionResult {
  status: 'done' | 'failed' | 'proposed';
  result?: unknown;                  // success data, returned to LLM as tool_result
  proposed_change?: unknown;          // diff payload for destructive ops
  error?: { code: string; message: string };
}

/**
 * Execute a tool by name. For auto-execute tools, runs the DB op immediately.
 * For confirmation-required tools, computes the Was→Becomes diff and returns
 * { status: 'proposed', proposed_change } — caller writes status='proposed' to
 * the DB and pauses the SSE stream.
 */
export async function executeTool(
  name: ToolName,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult>;

/**
 * For destructive-tier tools that have already been confirmed, run the
 * underlying op now and return the result to feed back into the LLM stream.
 */
export async function executeProposedChange(
  toolCallId: string,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult>;
```

For each tool, implement the handler:
- **Read tools**: SELECT from the relevant tables, scope by `household_id`, return the row(s) as JSON. Soft-delete-aware (`WHERE deleted_at IS NULL` for active reads).
- **Auto-execute write tools**: INSERT/UPDATE the row + bump `updated_at`. Return the new/updated row.
- **Confirm-required write tools**: SELECT the current state, compute the diff in JS, return `{ status: 'proposed', proposed_change: { was: {...}, becomes: {...} } }`. Do NOT execute yet — that happens when `executeProposedChange` is called later.

Keep handlers small — each is ~5-15 lines. If a handler grows beyond 30 lines or starts duplicating route logic, extract a shared helper in `src/lib/<domain>/` instead.

- [ ] **Step 3: Write tests**

`src/lib/assistant/__tests__/executor.test.ts`. Tests need a Postgres instance — use the existing test-DB setup pattern (read how other DB-touching libs are tested; if there's no precedent, mock `getSql` with a small in-memory stub for the v1 tests and add a `*-smoke.ts` integration check in Task 10 for the real DB integration).

Minimum invariants:
- Each read tool returns a non-empty result shape for a fixture row.
- Each auto-execute tool inserts/updates a row.
- Each confirm-required tool returns `status: 'proposed'` with a non-null `proposed_change` and does NOT mutate the DB.
- `executeProposedChange` runs the deferred mutation when given a confirmed tool_call_id.
- Unknown tool name → `{ status: 'failed', error: { code: 'unknown_tool' } }`.

If mocking the SQL is too much for v1, mark the executor tests as smoke-only and skip the unit tests for the handlers themselves (rely on Task 10 smoke for coverage). But **DO** unit-test the diff-computation logic for confirm-required tools — that's pure and worth covering.

- [ ] **Step 4: Run tests + typecheck**

`bun run typecheck && bun run test 2>&1 | tail -5` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/assistant/executor.ts src/lib/assistant/__tests__/executor.test.ts
git commit -m "Add assistant tool executor: read/write handlers + proposed-change diffs"
```

---

## Task 7: Anthropic streaming client + SSE parser

**Goal**: A pure async function that streams from `api.anthropic.com/v1/messages` and yields parsed events.

**Files:**
- Create: `src/lib/assistant/anthropicStream.ts`
- Create: `src/lib/assistant/__tests__/anthropicStream.test.ts`

- [ ] **Step 1: Read the existing Anthropic call pattern**

```bash
cat src/lib/recommendation/aiFallback.ts
cat src/lib/extraction/anthropic.ts
```

These both use raw `fetch()` to `api.anthropic.com/v1/messages`. The new streaming call is the same shape but adds `stream: true` to the body. The response is a stream of `data: {...}\n\n` SSE lines per Anthropic's [streaming docs](https://docs.anthropic.com/en/api/messages-streaming).

- [ ] **Step 2: Write the module**

`src/lib/assistant/anthropicStream.ts`:

```typescript
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: Array<{ type: 'text', text: string } | { type: 'tool_use', id: string, name: string, input: object } | { type: 'tool_result', tool_use_id: string, content: string | object, is_error?: boolean }>;
}

export interface AnthropicStreamConfig {
  apiKey: string;
  model: string;        // e.g. 'claude-opus-4-7'
  system: string;       // system prompt
  messages: AnthropicMessage[];
  tools: Array<{ name: string; description: string; input_schema: object }>;
  maxTokens?: number;   // default 4096
}

export type AnthropicEvent =
  | { type: 'message_start'; message: { id: string; model: string; usage: { input_tokens: number; output_tokens: number } } }
  | { type: 'content_block_start'; index: number; content_block: { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: object } }
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason?: string }; usage?: { output_tokens: number } }
  | { type: 'message_stop' }
  | { type: 'error'; error: { type: string; message: string } };

/**
 * Stream a response from Anthropic's Messages API. Yields parsed events
 * as they arrive. Caller is responsible for assembling text/tool_use blocks
 * from deltas + dispatching tool calls.
 */
export async function* streamAnthropic(config: AnthropicStreamConfig): AsyncGenerator<AnthropicEvent>;
```

Implementation:
1. POST to `https://api.anthropic.com/v1/messages` with `stream: true`.
2. Headers: `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`.
3. Read response.body as a `ReadableStream<Uint8Array>`. Decode as UTF-8.
4. Parse SSE lines: split on `\n\n`, each chunk has `event: <name>` then `data: <json>` lines. Extract the JSON, parse, yield.
5. Handle partial frames across stream chunks (buffer the unfinished tail).

**Reference Anthropic docs for the exact event shapes; don't guess.** Anthropic's streaming format is documented and stable; encoding it from memory will land wrong.

- [ ] **Step 3: Write tests with mocked fetch**

Mock `globalThis.fetch` to return a controllable `ReadableStream`. Feed in canned SSE chunks (one full + a chunked one to exercise the buffering logic) and assert the yielded events.

Cover at minimum:
- A complete simple text response (`message_start` → `content_block_start` → `content_block_delta` × N → `content_block_stop` → `message_stop`).
- A response with a tool_use block (input arrives via `input_json_delta` chunks; assert the parser yields each delta).
- A response chunked at byte boundaries that split a single SSE event in two TCP reads (verify buffering works).
- An error event (`event: error\ndata: {...}`) yields the right type.
- Malformed JSON in a `data:` line is logged + skipped, not fatal.

- [ ] **Step 4: Run tests**

`bun run test src/lib/assistant 2>&1 | tail -5` — passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/assistant/anthropicStream.ts src/lib/assistant/__tests__/anthropicStream.test.ts
git commit -m "Add Anthropic streaming client + SSE parser"
```

---

## Task 8: Prompt builder + Sprout persona

**Goal**: Build the system prompt that gives Sprout its voice + the per-call household snapshot.

**Files:**
- Create: `src/lib/assistant/prompt.ts`
- Create: `src/lib/assistant/__tests__/prompt.test.ts`

- [ ] **Step 1: Write the prompt builder**

`src/lib/assistant/prompt.ts`:

```typescript
export interface HouseholdSnapshot {
  homeZip: string | null;
  usdaZone: string | null;
  avgLastFrost: string | null;       // 'MM-DD'
  avgFirstFrost: string | null;
  regionId: string | null;           // state code
  seedCount: number;
  bedCount: number;
  recentJournalEntryCount: number;   // last 30 days
}

export interface PageContext {
  pageType: string;     // 'seed' | 'bed' | 'planting_event' | 'garden' | etc.
  entityId?: string;
  label?: string;       // human-readable, e.g. "Habanada Pepper"
}

export function buildSystemPrompt(
  snapshot: HouseholdSnapshot,
  pageContext: PageContext | null,
  now: Date,
): string;
```

The system prompt should:
1. Establish Sprout's persona (knowledgeable garden-mentor; plain voice; no exclamation marks; references the user's actual history when possible).
2. Convey the household snapshot (location, zone, frost dates, inventory size) so the LLM can ground answers without needing to call `get_household_location` on every turn.
3. Include the current date in YYYY-MM-DD format so the LLM can reason about "this spring", "last fall", etc.
4. If `pageContext` is non-null, prepend a line: "The user is currently viewing: {pageType} — {label}."
5. Explain the tool model briefly: "Use tools to read the user's actual data instead of guessing. Destructive operations (delete, large updates) will require user confirmation; that's expected — describe what you'd change and let the system handle the approval flow."

Keep the prompt under 600 words. Sprout's persona shouldn't be a wall of rules; lean on a few clear principles.

- [ ] **Step 2: Write tests**

Cover:
- Prompt includes the household snapshot fields.
- Prompt includes the current date.
- Prompt includes the page context when provided.
- Prompt is the same when called twice with the same args (deterministic — no `Date.now()` inside).
- Prompt mentions Sprout's persona principles (a few keyword checks).

- [ ] **Step 3: Run tests**

`bun run test src/lib/assistant/__tests__/prompt 2>&1 | tail -3` — passing.

- [ ] **Step 4: Commit**

```bash
git add src/lib/assistant/prompt.ts src/lib/assistant/__tests__/prompt.test.ts
git commit -m "Add Sprout system-prompt builder with household snapshot + page context"
```

---

## Task 9: Streaming endpoint + tool-call orchestration

**Goal**: `POST /api/assistant/threads/:id/stream` — sends a user message, streams Anthropic's response, executes tools, persists everything, pauses on proposed changes.

**Files:**
- Modify: `src/routes/assistant.ts`

- [ ] **Step 1: Read SimmerSmith's stream-event shape**

```bash
grep -A 30 "streamAssistantResponse\|SSE\|data:" ~/git/simmersmith/SimmerSmithKit/Sources/SimmerSmithKit/API/SimmerSmithAPIClient.swift | head -80
```

Confirm what SSE event names + payload shapes SimmerSmith uses so iOS T2 can mirror them. The spec defines our events (`text_delta`, `tool_use_start`, `tool_use_done`, `tool_result`, `proposed_change`, `done`, `error`) — verify they're a superset / consistent with SimmerSmith's choices.

- [ ] **Step 2: Add the streaming route**

In `src/routes/assistant.ts`, add `POST /threads/:id/stream`:

```typescript
assistantRoutes.post('/threads/:id/stream', ...auth, async (c) => {
  // 1. Validate thread exists + belongs to household + not deleted.
  // 2. Load the encrypted API key for household + decrypt.
  // 3. Insert the user message into assistant_messages.
  // 4. Build the conversation history: SELECT messages for thread ORDER BY created_at ASC.
  // 5. Build the system prompt (loadHouseholdSnapshot + page_context from body).
  // 6. Open SSE response: `text/event-stream`, send headers + flush.
  // 7. Call streamAnthropic with system + messages + tools.
  // 8. Iterate the async generator:
  //    - On text_delta: emit `data: {"type":"text_delta", ...}\n\n` to client; accumulate in assistant message buffer.
  //    - On tool_use_start: emit; create assistant_tool_calls row with status='running'.
  //    - On content_block_stop for tool_use: validate args via TOOL_REGISTRY; if invalid, set status='failed' + emit tool_result with error.
  //    - For valid tool_use: if requires_confirmation, run executor in "propose" mode → write status='proposed' + proposed_change → emit `proposed_change` event → CLOSE THE STREAM and return. Frontend confirms via separate route.
  //    - Else (auto-execute): run executor → write status='done' + result → emit tool_result → feed result back to Anthropic for the next turn. **This requires re-streaming with the tool_result added to messages.**
  // 9. On message_stop: write the assistant message to DB (full content_json) → emit `done` event → close stream.
});
```

The "feed tool result back for next turn" loop is the trickiest part. Pattern: Anthropic's first stream finishes with a `tool_use` content block. The server now needs to:
1. Mark the tool call as done in DB.
2. Append a new `tool` role message with `tool_result` content.
3. Call `streamAnthropic` again with the updated messages.
4. Continue emitting deltas + tool calls until the model stops without a tool_use (i.e., a final text response).

This is essentially an iterative loop:

```typescript
let messages = [...history, userMessage];
while (true) {
  const events = streamAnthropic({ apiKey, model, system, messages, tools });
  let stoppedDueTo: 'tool_use' | 'end' = 'end';
  for await (const ev of events) {
    // ... emit deltas, accumulate blocks, handle tool calls ...
  }
  if (stoppedDueTo === 'end') break;
  // Otherwise, the messages array has been extended with the assistant
  // message + tool_result message; loop and call Anthropic again.
}
```

**Resource ceiling**: enforce `max_turns_per_message = 10` and `max_tokens_per_thread_per_day = 200_000` server-side. Exceed → respond with `{ type: 'error', code: 'budget_exceeded' }` and close the stream.

- [ ] **Step 3: Add confirm + cancel routes**

In `src/routes/assistant.ts`, add:

```typescript
assistantRoutes.post('/tool_calls/:id/confirm', ...auth, async (c) => {
  // 1. Load tool_call; verify household ownership; verify status='proposed'.
  // 2. Run executor.executeProposedChange(toolCallId, ctx).
  // 3. Update tool_call: status='done', result_json, confirmed_at = Date.now().
  // 4. Return { ok: true, data: { tool_call_id, status: 'done', result } }.
  //
  // Note: this route does NOT open a new SSE stream. iOS triggers the next
  // stream by POSTing to /threads/:id/stream with the tool_result already
  // in the conversation history (server reads messages ASC + includes
  // tool_result messages built from confirmed tool_calls).
});

assistantRoutes.post('/tool_calls/:id/cancel', ...auth, async (c) => {
  // Similar: update tool_call.status='cancelled', no execution.
  // iOS POSTs back to /stream with a tool_result indicating cancellation.
});
```

**Decision on resume mechanism**: keep `/confirm` simple — it just updates the DB row. iOS handles resuming by sending a new user message via `/stream` (or a follow-up that triggers the LLM to continue). Per the spec, this is "the server opens a fresh stream that picks up from the persisted state" — which means iOS POSTs to `/stream` again with a synthetic "continue" message (could be empty text + a marker). **Verify with the spec; if the spec assumes the server auto-opens a new stream after confirm, change this design.**

[Reading the spec...] — the spec says "When the user confirms, iOS POSTs to `/confirm` and the server **opens a new SSE stream**". This suggests `/confirm` itself returns an SSE stream that resumes the conversation. Implement that: make `/confirm` an SSE endpoint that:
1. Runs the executor.
2. Writes the tool_result into the conversation.
3. Calls Anthropic with the updated messages.
4. Streams the continuation back.

`/cancel` is simpler — just marks the tool_call cancelled and returns a regular JSON response; iOS triggers continuation via a new `/stream` call.

- [ ] **Step 4: Typecheck + test**

```bash
bun run typecheck
bun run test 2>&1 | tail -3
```
Green.

- [ ] **Step 5: Commit**

```bash
git add src/routes/assistant.ts
git commit -m "Add streaming endpoint + tool-call orchestration loop + confirm/cancel routes"
```

---

## Task 10: Smoke script — end-to-end against mocked Anthropic

**Goal**: 15-ish smoke checks exercising every route. Mock the Anthropic outbound call so we don't burn real tokens.

**Files:**
- Create: `scripts/assistant-smoke.ts`

- [ ] **Step 1: Read existing smokes**

```bash
head -100 scripts/journal-smoke.ts
head -100 scripts/recommendations-smoke.ts
```

Follow the same shape: direct `postgres` insert for fixtures, bearer-token `api()` helper, `check()` counters, `finally` cleanup with `smoke-*-` prefixed IDs.

- [ ] **Step 2: Set up Anthropic mocking**

For the smoke to run without hitting real Anthropic, the dev server needs to dispatch to a mock when env `ASSISTANT_ANTHROPIC_MOCK=1` is set. Add to `src/lib/assistant/anthropicStream.ts`:

```typescript
// Test-only mock: when ASSISTANT_ANTHROPIC_MOCK is set, yield canned events
// instead of hitting api.anthropic.com. The mock implementation looks at the
// last user message and returns a deterministic response shape based on a
// prefix marker (e.g. user message starting with "MOCK:tool_use_then_text"
// yields a tool_use then a text response).
```

Document the marker protocol in the file. Smoke script sends messages with the marker; mock returns predetermined event streams that exercise the orchestration loop.

Alternative if mock infrastructure is too much: **add a `MOCK_ANTHROPIC_URL` env var** that the streamAnthropic module routes to instead of `api.anthropic.com` when set. Spin up a tiny Bun-side HTTP server in the smoke script that returns canned SSE. Probably cleaner than in-process mocking. **Choose whichever fits the existing test patterns better — read other smokes to decide.**

- [ ] **Step 3: Write the smoke**

`scripts/assistant-smoke.ts`. ~15 checks:

1. PUT `/me/assistant_key` with a fake key → 200, configured=true.
2. GET `/me/assistant_key` → providers includes anthropic, configured=true.
3. POST `/assistant/threads` → 200, returns thread id.
4. GET `/assistant/threads?since=0` → items includes the new thread.
5. GET `/assistant/threads/:id` → 200, messages empty.
6. POST `/assistant/threads/:id/stream` with MOCK marker for "simple text response" → SSE: text_delta × N + done; assistant message persisted.
7. POST `/assistant/threads/:id/stream` with MOCK marker for "tool_use list_seeds" → SSE: tool_use_start + tool_use_done + tool_result + (continued text deltas) + done; tool_call row persisted with status='done'.
8. POST `/assistant/threads/:id/stream` with MOCK marker for "delete_seed proposed" → SSE: tool_use_start + tool_use_done + proposed_change; stream closes; tool_call row status='proposed'.
9. POST `/assistant/tool_calls/:id/confirm` → SSE continuation + tool_result; tool_call status='done'.
10. POST `/assistant/tool_calls/:id/cancel` for a different proposed tool → 200, status='cancelled'.
11. PATCH `/assistant/threads/:id` with new title → updated.
12. Bad tool args (MOCK yields tool_use with invalid args) → tool_call status='failed'; error result emitted.
13. Budget cap (MOCK yields a runaway loop) → server emits budget_exceeded error.
14. DELETE `/assistant/threads/:id` → 200; subsequent GET threads excludes it.
15. DELETE `/me/assistant_key` → 200, configured=false; subsequent stream call fails with `no_assistant_key` error.

Cleanup in `finally`: delete tool_calls, messages, threads, key, household, membership, session, user — by `smoke-*-` prefix or by captured IDs.

- [ ] **Step 4: Run smoke**

```bash
ASSISTANT_KEY_MASTER="$(openssl rand -base64 32)" ASSISTANT_ANTHROPIC_MOCK=1 bun run dev &
DEV_PID=$!
sleep 3
ASSISTANT_ANTHROPIC_MOCK=1 bun run scripts/assistant-smoke.ts
SMOKE_EXIT=$?
kill $DEV_PID 2>/dev/null
```
Expected: 15/15 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/assistant-smoke.ts src/lib/assistant/anthropicStream.ts
git commit -m "Add assistant-smoke.ts (15 checks) + Anthropic mock for smoke testing"
```

---

## Task 11: Deploy to Fly v16 + verify

**Files:** none — verification + deploy.

- [ ] **Step 1: Final pre-deploy gate**

```bash
cd /Users/tfinklea/git/seedkeep-server/.worktrees/phase-4-sprout-server
bun run typecheck
bun run test 2>&1 | tail -5
```
Expected: typecheck clean; tests = 66 (baseline) + new tests from Tasks 2/5/6/7/8 (probably ~30-40 new). All green.

Plus smoke gate:
```bash
ASSISTANT_KEY_MASTER="$(openssl rand -base64 32)" ASSISTANT_ANTHROPIC_MOCK=1 bun run dev > /tmp/dev.log 2>&1 &
DEV=$!
sleep 3
ASSISTANT_ANTHROPIC_MOCK=1 bun run scripts/assistant-smoke.ts
EXIT=$?
kill $DEV 2>/dev/null
echo "smoke exit: $EXIT"
```

Plus regression — verify journal-smoke still 11/11 and recommendations-smoke still passing.

- [ ] **Step 2: Set `ASSISTANT_KEY_MASTER` on Fly**

```bash
fly secrets set ASSISTANT_KEY_MASTER="$(openssl rand -base64 32)" -a seedkeep-server
```

This triggers a Fly machine restart, which is fine — no migration runs yet.

- [ ] **Step 3: Merge worktree to main**

```bash
cd /Users/tfinklea/git/seedkeep-server
git fetch origin
git merge --ff-only phase-4-sprout-server
git push origin main
```

If the merge or push is blocked by the auto-mode classifier, push the branch to origin (`git push -u origin phase-4-sprout-server`) and ask the user to merge via PR.

- [ ] **Step 4: Deploy**

```bash
fly deploy --ha=false
```
Expected: `release_command` runs `bun run migrate` (applies 0012); `** Visit your newly deployed app at https://seedkeep-server.fly.dev/ **`.

- [ ] **Step 5: Verify production health**

```bash
curl -s https://seedkeep-server.fly.dev/api/health
```
Expected: `{"ok":true,"data":{"status":"healthy","env":"production"}}`.

Verify the new routes are reachable (401 unauthed is correct):
```bash
for path in "/api/assistant/threads" "/api/households/me/assistant_key"; do
  echo -n "$path: "
  curl -s -o /dev/null -w "%{http_code}\n" https://seedkeep-server.fly.dev$path
done
```
Expected: both 401.

- [ ] **Step 6: Clean up worktree**

```bash
cd /Users/tfinklea/git/seedkeep-server
git worktree remove --force .worktrees/phase-4-sprout-server
git branch -d phase-4-sprout-server
```

- [ ] **Step 7: Update AI docs**

Append to `.docs/ai/current-state.md`:

```markdown
**Date**: YYYY-MM-DD — Phase 4 (Sprout) server foundation deployed (Fly v16)

- Migration 0012 (4 tables) + key encryption + 5 new routes + tool registry (24 tools) + Anthropic streaming + smoke (15 checks).
- Fly v16. iOS work in `seedkeep-ios/.docs/ai/plans/2026-05-25-phase-4-sprout-ios.md`.
- `ASSISTANT_KEY_MASTER` secret set on Fly.
- Coverage: 24 tools total — 11 read auto-execute, 4 write auto-execute, 9 require proposed-change confirmation (4 update, 4 delete, set_household_location).
```

- [ ] **Step 8: Push docs**

```bash
git add .docs/ai/current-state.md
git commit -m "Update current-state: Phase 4 server foundation deployed (Fly v16)"
git push origin main
```

---

## Self-review checklist (verify before marking plan complete)

- [ ] Migration 0012 schema matches the spec's "Data model — server" section exactly (4 tables, all indexes, CHECK constraints, FK ON DELETE CASCADE).
- [ ] Key encryption uses AES-256-GCM with 12-byte IV + 16-byte tag, mastered by `ASSISTANT_KEY_MASTER`.
- [ ] All 24 tools from the spec's tool surface are in the registry with the correct `requires_confirmation` flag.
- [ ] SSE event types match the spec exactly: `text_delta`, `tool_use_start`, `tool_use_done`, `tool_result`, `proposed_change`, `done`, `error`.
- [ ] Smoke script exercises every route at least once, including the proposed-change confirm + cancel paths.
- [ ] `ASSISTANT_KEY_MASTER` set on Fly before deploy.
- [ ] Migration applies via `release_command` on deploy.
- [ ] No new runtime dependencies added to `package.json`.
