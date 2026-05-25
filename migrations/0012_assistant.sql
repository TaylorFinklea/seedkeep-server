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
-- No data backfill is required — these are new tables with no pre-Phase-4 data.

CREATE TABLE IF NOT EXISTS assistant_keys (
  household_id   TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL CHECK (provider IN ('anthropic')),  -- v1 single provider
  encrypted_key  BYTEA NOT NULL,    -- AES-256-GCM ciphertext
  key_iv         BYTEA NOT NULL,    -- 12-byte IV for GCM
  key_tag        BYTEA NOT NULL,    -- 16-byte GCM auth tag
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL,
  PRIMARY KEY (household_id, provider)
);

CREATE TABLE IF NOT EXISTS assistant_threads (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  title         TEXT NOT NULL DEFAULT '',
  thread_kind   TEXT NOT NULL DEFAULT 'chat',  -- future intents; open-ended
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  deleted_at    BIGINT
);
CREATE INDEX IF NOT EXISTS idx_assistant_threads_household_updated
  ON assistant_threads(household_id, updated_at DESC);
-- Active-list index follows the project-wide partial-on-deleted_at idiom
-- (cf. journal_entries from migration 0011).
CREATE INDEX IF NOT EXISTS idx_assistant_threads_household_active
  ON assistant_threads(household_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS assistant_messages (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content_json  TEXT NOT NULL,   -- Anthropic content-block JSON: text + tool_use + tool_result
  page_context  TEXT,            -- Optional JSON: { pageType, entityId, label, ... }
  model         TEXT,            -- e.g. 'claude-opus-4-7' (assistant msgs only)
  usage_json    TEXT,            -- input/output token counts (assistant msgs only)
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_thread
  ON assistant_messages(thread_id, created_at ASC);

CREATE TABLE IF NOT EXISTS assistant_tool_calls (
  id                    TEXT PRIMARY KEY,
  message_id            TEXT NOT NULL REFERENCES assistant_messages(id) ON DELETE CASCADE,
  thread_id             TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
  tool_name             TEXT NOT NULL,
  args_json             TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (
                          status IN ('proposed', 'running', 'done', 'failed', 'cancelled')
                        ),
  result_json           TEXT,             -- success result or error detail
  proposed_change_json  TEXT,             -- Was→Becomes diff for destructive ops
  confirmed_at          BIGINT,
  created_at            BIGINT NOT NULL,
  updated_at            BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_tool_calls_thread
  ON assistant_tool_calls(thread_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_assistant_tool_calls_message
  ON assistant_tool_calls(message_id);
-- Cheap lookup for "any pending confirmations for this thread?" — used by the
-- assistant route to gate sending a new user message while a destructive op
-- is still awaiting confirmation.
CREATE INDEX IF NOT EXISTS idx_assistant_tool_calls_proposed
  ON assistant_tool_calls(thread_id) WHERE status = 'proposed';
