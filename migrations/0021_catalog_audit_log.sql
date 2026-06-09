-- Migration: Phase 4D · catalog audit log.
--
-- Append-only ledger of every catalog_seeds mutation routed through
-- the corrections pipeline. Intentionally has NO foreign key to
-- catalog_seeds.id — audit history must survive catalog row deletion
-- so we can still answer "what changed and when" after a row goes
-- away.
--
-- Sources:
--   auto_apply    — worker tick applied a high-confidence correction
--   manual_apply  — admin clicked Approve on the triage page
--   manual_revert — admin used POST /api/catalog/:id/revert/:audit_id
--                   to undo an earlier audit row
--
-- Retention: worker's sweepAuditLog deletes rows older than 18 months
-- once per UTC day (gated by a sentinel row).

CREATE TABLE catalog_audit_log (
  id                 TEXT PRIMARY KEY,
  catalog_seed_id    TEXT NOT NULL,              -- no FK; survives row deletion
  field_name         TEXT NOT NULL,
  old_value          TEXT,
  new_value          TEXT,
  source             TEXT NOT NULL
                     CHECK (source IN ('auto_apply','manual_apply','manual_revert')),
  correction_id      TEXT REFERENCES catalog_feedback(id) ON DELETE SET NULL,
  actor_user_id      TEXT,                       -- INTERNAL-ONLY: never exposed publicly
  ai_self_confidence NUMERIC(3,2),
  ai_review_score    NUMERIC(3,2),
  ai_raw_response    JSONB,                      -- prompt + response for postmortem
  created_at         BIGINT NOT NULL
);

CREATE INDEX catalog_audit_seed_recent
  ON catalog_audit_log(catalog_seed_id, created_at DESC);

CREATE INDEX catalog_audit_actor_revert
  ON catalog_audit_log(actor_user_id, source, created_at DESC)
  WHERE source = 'manual_revert';
