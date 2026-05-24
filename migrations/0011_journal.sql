-- Migration: Phase 3 (journal) foundation.
--
-- Adds three tables for the unified journal model:
--   journal_entries          — one entry per gardener-day, optional polymorphic
--                              attach to seed / bed / planting_event (CHECK
--                              enforces at-most-one).
--   journal_entry_photos     — photos attached to a journal entry; same S3
--                              bucket as seed_photos but a separate table
--                              so journal concerns don't bleed into seed_photos.
--   journal_checklist_items  — flat checklist items per entry; separate table
--                              for per-item sync granularity.
--
-- Also migrates existing planting_events.kind='note' rows into
-- journal_entries (the proto-journal that has sat unused since migration
-- 0005) and drops 'note' from the planting_events.kind CHECK constraint.
-- This is the one migration that BOTH adds schema AND backfills existing
-- data in the same transaction — required by the migration-backfill rule
-- (see decisions.md + the migration-backfill-required memory).

CREATE TABLE IF NOT EXISTS journal_entries (
  id                 TEXT PRIMARY KEY,
  household_id       TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  occurred_on        DATE NOT NULL,
  body               TEXT NOT NULL DEFAULT '',
  seed_id            TEXT REFERENCES seeds(id) ON DELETE CASCADE,
  bed_id             TEXT REFERENCES beds(id) ON DELETE CASCADE,
  planting_event_id  TEXT REFERENCES planting_events(id) ON DELETE CASCADE,
  CHECK ((seed_id IS NOT NULL)::int + (bed_id IS NOT NULL)::int +
         (planting_event_id IS NOT NULL)::int <= 1),
  created_at         BIGINT NOT NULL,
  updated_at         BIGINT NOT NULL,
  deleted_at         BIGINT
);

-- Active timeline feed: partial index on deleted_at IS NULL matches the
-- household-active idiom from migration 0005 (beds, planting_events).
CREATE INDEX IF NOT EXISTS idx_journal_entries_household_occurred
  ON journal_entries(household_id, occurred_on DESC) WHERE deleted_at IS NULL;
-- Delta-sync index intentionally NOT partial: clients must learn about
-- soft-deletes (rows with deleted_at set) to mirror tombstones locally.
CREATE INDEX IF NOT EXISTS idx_journal_entries_household_updated
  ON journal_entries(household_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_journal_entries_seed
  ON journal_entries(seed_id) WHERE seed_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_bed
  ON journal_entries(bed_id) WHERE bed_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_event
  ON journal_entries(planting_event_id) WHERE planting_event_id IS NOT NULL;

-- Note on soft-delete: photos and checklist items intentionally have NO
-- deleted_at column (locked decision #6 in the journal spec). They are owned
-- strictly by the parent entry: every read path joins through
-- journal_entries.deleted_at IS NULL, so a soft-deleted parent makes its
-- children invisible without a per-child tombstone. updated_at IS required,
-- though, so delta-sync can learn about reorders and content edits.
CREATE TABLE IF NOT EXISTS journal_entry_photos (
  id            TEXT PRIMARY KEY,
  entry_id      TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  storage_key   TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  width         INTEGER,
  height        INTEGER,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_photos_entry
  ON journal_entry_photos(entry_id, sort_order);

CREATE TABLE IF NOT EXISTS journal_checklist_items (
  id          TEXT PRIMARY KEY,
  entry_id    TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  completed   BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  updated_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checklist_items_entry
  ON journal_checklist_items(entry_id, sort_order);

-- Convert existing free-form note events into journal entries.
-- Reuses the event ID as the journal entry ID — cheap defensive: any local
-- code still pointing at the old ID reconciles cleanly without a lookup table.
INSERT INTO journal_entries (id, household_id, occurred_on, body, bed_id,
                             created_at, updated_at)
SELECT id, household_id, planned_for, COALESCE(notes, ''), bed_id,
       created_at, updated_at
  FROM planting_events
 WHERE kind = 'note' AND deleted_at IS NULL
ON CONFLICT (id) DO NOTHING;

-- Soft-delete the migrated planting_events rows so two-device merges see
-- "removed" not "vanished." Hard-deleting would lose the sync watermark.
-- NOW() here is wall-clock at migration time, which is intentional: the
-- legacy row needs an updated_at strictly newer than any extant client
-- cursor so every device learns about the deletion on next delta-sync. The
-- migration runs once, on the server, so there's no clock-skew risk.
UPDATE planting_events
   SET deleted_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
       updated_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
 WHERE kind = 'note' AND deleted_at IS NULL;

-- Rebuild the kind CHECK without 'note'. Same DROP+ADD pattern migration
-- 0009 used for recommendation_cache.source.
ALTER TABLE planting_events DROP CONSTRAINT IF EXISTS planting_events_kind_check;
ALTER TABLE planting_events ADD CONSTRAINT planting_events_kind_check
  CHECK (kind IN ('sowing', 'transplant', 'harvest'));
