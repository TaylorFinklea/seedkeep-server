-- Migration: Phase 4D · structured catalog corrections.
--
-- Extends the write-once `catalog_feedback` bin (migration 0013) into a
-- structured queue the AI moderation worker can drain. Free-form rows
-- from the legacy POST shape continue to insert with field_name=NULL;
-- the worker's claim filter skips them. They still surface via the
-- admin triage page.
--
-- Highlights:
--   - All new columns are nullable (or have defaults) — legacy rows
--     remain valid.
--   - CASCADE FKs on catalog_seed_id and household_id flip to SET NULL
--     so audit history outlives catalog row deletion + household exit.
--   - Cross-field invariants land on catalog_seeds as DB CHECK
--     constraints (load-bearing safety net for auto-apply).
--   - Indexes target worker claim, idempotency replay, per-user rate
--     limits, role-based daily quota, and the partial UNIQUE that
--     forces 23505 on duplicate open corrections per (user, seed, field).
--   - Trigger on the `memberships` table dismisses open corrections
--     when a user loses access to the household they submitted from.

BEGIN;

-- 1. Add structured columns to catalog_feedback.
ALTER TABLE catalog_feedback
  ADD COLUMN field_name TEXT
    CHECK (field_name IS NULL OR field_name IN (
      'days_to_germinate_min','days_to_germinate_max',
      'days_to_maturity_min','days_to_maturity_max',
      'soil_temp_min_f','soil_temp_max_f',
      'seed_depth_inches','plant_spacing_inches','row_spacing_inches',
      'hardiness_zone_min','hardiness_zone_max','viability_years',
      'sun_requirement','frost_tolerance','sow_method','life_cycle',
      'scientific_name','common_name','variety','company','instructions',
      'other'
    )),
  ADD COLUMN suggested_value TEXT
    CHECK (suggested_value IS NULL OR length(suggested_value) BETWEEN 1 AND 2000),
  ADD COLUMN client_seen_value TEXT,
  ADD COLUMN value_type TEXT
    CHECK (value_type IS NULL OR value_type IN ('integer','numeric','enum','text','free_form')),
  ADD COLUMN catalog_seed_name TEXT,
  ADD COLUMN user_acknowledged_bounds BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN ai_self_confidence NUMERIC(3,2),
  ADD COLUMN ai_review_score NUMERIC(3,2),
  ADD COLUMN ai_notes TEXT CHECK (ai_notes IS NULL OR length(ai_notes) <= 240),
  ADD COLUMN ai_raw_response JSONB,
  ADD COLUMN ai_locked_at BIGINT,
  ADD COLUMN ai_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN ai_last_error TEXT,
  ADD COLUMN ai_next_attempt_at BIGINT,
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN conflict_with_id TEXT REFERENCES catalog_feedback(id) ON DELETE SET NULL,
  ADD COLUMN applied_at BIGINT,
  ADD COLUMN dismissed_reason TEXT,
  ADD COLUMN escalated_at BIGINT,
  ADD COLUMN notified_first_at BIGINT,
  ADD COLUMN updated_at BIGINT NOT NULL DEFAULT 0;

-- 2. Allow catalog_seed_id / household_id to be NULL after row deletion.
ALTER TABLE catalog_feedback
  ALTER COLUMN catalog_seed_id DROP NOT NULL,
  ALTER COLUMN household_id   DROP NOT NULL;

ALTER TABLE catalog_feedback
  DROP CONSTRAINT catalog_feedback_catalog_seed_id_fkey,
  ADD CONSTRAINT catalog_feedback_catalog_seed_id_fkey
    FOREIGN KEY (catalog_seed_id) REFERENCES catalog_seeds(id) ON DELETE SET NULL;

ALTER TABLE catalog_feedback
  DROP CONSTRAINT catalog_feedback_household_id_fkey,
  ADD CONSTRAINT catalog_feedback_household_id_fkey
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE SET NULL;

-- 3. Cross-field invariants on catalog_seeds — the load-bearing safety
--    net that aborts the auto-apply tx if min/max relationship would
--    invert. Worker pre-checks the same invariant for friendlier UX,
--    but DB CHECK is the authoritative gate.
ALTER TABLE catalog_seeds
  ADD CONSTRAINT cs_days_to_germinate_min_le_max
    CHECK (days_to_germinate_min IS NULL OR days_to_germinate_max IS NULL
           OR days_to_germinate_min <= days_to_germinate_max),
  ADD CONSTRAINT cs_days_to_maturity_min_le_max
    CHECK (days_to_maturity_min IS NULL OR days_to_maturity_max IS NULL
           OR days_to_maturity_min <= days_to_maturity_max),
  ADD CONSTRAINT cs_soil_temp_min_le_max
    CHECK (soil_temp_min_f IS NULL OR soil_temp_max_f IS NULL
           OR soil_temp_min_f <= soil_temp_max_f),
  ADD CONSTRAINT cs_hardiness_zone_min_le_max
    CHECK (hardiness_zone_min IS NULL OR hardiness_zone_max IS NULL
           OR hardiness_zone_min <= hardiness_zone_max);

-- 4. Indexes.
CREATE UNIQUE INDEX catalog_feedback_idempotency
  ON catalog_feedback(idempotency_key, user_id)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX catalog_feedback_one_open_per_field
  ON catalog_feedback(user_id, catalog_seed_id, field_name)
  WHERE status = 'open' AND field_name IS NOT NULL AND user_id IS NOT NULL;

CREATE INDEX catalog_feedback_worker_claim
  ON catalog_feedback(status, COALESCE(ai_next_attempt_at, created_at))
  WHERE status = 'open' AND field_name IS NOT NULL;

CREATE INDEX catalog_feedback_user_updated
  ON catalog_feedback(user_id, updated_at);

CREATE INDEX catalog_feedback_user_rate
  ON catalog_feedback(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX catalog_feedback_user_auto_apply_daily
  ON catalog_feedback(user_id, applied_at)
  WHERE status = 'applied' AND applied_at IS NOT NULL;

-- 5. Server-side notification ledger (cross-device dedup).
CREATE TABLE catalog_correction_notifications (
  correction_id TEXT NOT NULL REFERENCES catalog_feedback(id) ON DELETE CASCADE,
  device_id     TEXT NOT NULL,
  notified_at   BIGINT NOT NULL,
  PRIMARY KEY (correction_id, device_id)
);

-- 6. Household-membership revoke trigger: open corrections flip to dismissed.
--    The membership table in this schema is `memberships` (see migration
--    0001); the spec wrote `household_members` but the canonical name here
--    is `memberships`.
CREATE OR REPLACE FUNCTION dismiss_orphaned_corrections() RETURNS TRIGGER AS $$
BEGIN
  UPDATE catalog_feedback
  SET status = 'dismissed',
      dismissed_reason = 'household_membership_revoked',
      reviewed_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      updated_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
  WHERE user_id = OLD.user_id AND household_id = OLD.household_id AND status = 'open';
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_dismiss_orphaned_corrections
  AFTER DELETE ON memberships
  FOR EACH ROW EXECUTE FUNCTION dismiss_orphaned_corrections();

COMMIT;
