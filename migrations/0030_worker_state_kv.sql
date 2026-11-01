-- Shared worker heartbeat, backup, and moderation sweep sentinels.
-- Runtime processes only read/write rows; schema changes stay operator-controlled.
CREATE TABLE IF NOT EXISTS _seedkeep_kv (
  k TEXT PRIMARY KEY,
  v TEXT
);
