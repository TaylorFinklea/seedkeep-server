-- Phase 4 D · Community catalog correction feedback.
--
-- Stores user-submitted corrections / observations about catalog entries.
-- Read-only for now from the user's side: this is a write-once collection
-- bin. A future moderation tool can review the queue and roll changes
-- back into `catalog_seeds`.

CREATE TABLE IF NOT EXISTS catalog_feedback (
    id              TEXT PRIMARY KEY,
    catalog_seed_id TEXT NOT NULL REFERENCES catalog_seeds(id) ON DELETE CASCADE,
    household_id    TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    user_id         TEXT REFERENCES "user"(id) ON DELETE SET NULL,
    -- Free-form text the user typed. Reviewers read this directly; no
    -- structured schema yet.
    body            TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
    -- Optional field hint — when the user clicks a specific field's
    -- "suggest correction" link, we record which field they meant.
    field_hint      TEXT,
    status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'reviewed', 'applied', 'dismissed')),
    created_at      BIGINT NOT NULL,
    reviewed_at     BIGINT
);

CREATE INDEX IF NOT EXISTS catalog_feedback_catalog_idx
    ON catalog_feedback(catalog_seed_id);
CREATE INDEX IF NOT EXISTS catalog_feedback_status_idx
    ON catalog_feedback(status) WHERE status = 'open';
