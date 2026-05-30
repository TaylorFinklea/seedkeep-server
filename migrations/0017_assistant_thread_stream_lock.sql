-- Phase 4 (continued) · Thread-level stream lock.
--
-- The streaming endpoint and the proposed-change confirmation endpoint
-- both call Anthropic and persist assistant messages. Without a lock,
-- two devices sending simultaneously can both pass the
-- pending-tool-call SELECT, both spawn an orchestration, and both
-- INSERT placeholder assistant_messages with millisecond-tied
-- created_at — corrupting conversation history.
--
-- `stream_lock_at` carries an opportunistic, expiring lock. The
-- orchestration sets it to `now` at start; the SSE finalizer clears
-- it. A stale lock (older than 10 min) is implicitly released on the
-- next acquire attempt — covers crashes mid-stream.

ALTER TABLE assistant_threads
  ADD COLUMN IF NOT EXISTS stream_lock_at BIGINT;
