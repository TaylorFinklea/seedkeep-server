-- Phase 5 · Plant pets foundation.
--
-- Adds the schema backing the "plant pets" core loop: every planting_event
-- gets a companion creature (pet) whose identity is computed exactly once on
-- the server (rarity roll, creature kind, AI personality vignette) and a
-- sidecar table records goodbye notes when a pet departs.
--
-- Authority split:
--   Server-of-record:  identity columns on planting_events
--                      (pet_seed, pet_rarity, pet_creature_kind, pet_name,
--                       pet_personality, pet_spawned_at) and the
--                      pet_departures row (goodbye note, departed_at).
--   iOS-of-record:     mood + lifecycle (derived from the synced inputs).
--
-- Why identity lives on planting_events (not a sidecar):
--   Pet identity is 1:1 with planting lifetime, joined on every read, and
--   has no orphan-row risk. Riding on planting_events means the existing
--   `pullPlantingEvents` delta-sync carries identity for free — no new
--   pull endpoint, no second SQL fetch on detail views.
--
-- Why pet_departures is a sidecar:
--   Departure is write-once at depart time with its own updated_at, and
--   the Menagerie tab queries departures across plantings — so a dedicated
--   delta-sync feed (keyed on household_id, updated_at) is justified.
--   `ON DELETE CASCADE` from planting_events keeps tombstones aligned with
--   hard-deletes; soft-deletes intentionally leave the departure row intact.
--
-- pet_personality and goodbye_note are TEXT holding JSON. This matches the
-- existing codebase convention (raw_extraction TEXT, content_json TEXT,
-- inputs_used TEXT in earlier migrations). JSONB would be a convention
-- break and we don't query into these payloads server-side.
--
-- pet_seed is the full 64-char lowercase hex sha256 of the planting_event
-- id (utf-8 bytes). Both server and any verifier compute the same pet
-- from the same id; the low 64 bits seed the xorshift64* PRNG that picks
-- rarity + creature kind.
--
-- Backfill: legacy rows get NULL identity columns. iOS gates pet UI on
-- `pet_seed IS NOT NULL`. The server's spawn route lazily fills legacy
-- rows on first read.

-- Identity columns on planting_events --------------------------------------
ALTER TABLE planting_events
  ADD COLUMN IF NOT EXISTS pet_seed TEXT;
ALTER TABLE planting_events
  ADD COLUMN IF NOT EXISTS pet_rarity TEXT;
ALTER TABLE planting_events
  ADD COLUMN IF NOT EXISTS pet_creature_kind TEXT;
ALTER TABLE planting_events
  ADD COLUMN IF NOT EXISTS pet_name TEXT;
ALTER TABLE planting_events
  ADD COLUMN IF NOT EXISTS pet_personality TEXT;
ALTER TABLE planting_events
  ADD COLUMN IF NOT EXISTS pet_spawned_at BIGINT;

-- Rarity CHECK. DROP + ADD pattern matches migration 0009/0011 for kind.
ALTER TABLE planting_events
  DROP CONSTRAINT IF EXISTS planting_events_pet_rarity_check;
ALTER TABLE planting_events
  ADD CONSTRAINT planting_events_pet_rarity_check
  CHECK (pet_rarity IS NULL OR pet_rarity IN
    ('common', 'uncommon', 'rare', 'legendary', 'mythical'));

-- Partial index: Today roll-call query — only spawned, not tombstoned,
-- not graduated. Mirrors the household-active idiom from migration 0005.
CREATE INDEX IF NOT EXISTS idx_planting_events_household_alive_pets
  ON planting_events (household_id, pet_spawned_at DESC)
  WHERE pet_seed IS NOT NULL
    AND deleted_at IS NULL
    AND completed_at IS NULL;

-- Sidecar: pet_departures --------------------------------------------------
-- goodbye_note is nullable: the depart route inserts the row first
-- (departed_at, reason) and then UPDATEs goodbye_note after the Sprout
-- call returns. A fallback retry job may also leave goodbye_note NULL
-- between attempts.
CREATE TABLE IF NOT EXISTS pet_departures (
  planting_event_id TEXT PRIMARY KEY
    REFERENCES planting_events(id) ON DELETE CASCADE,
  household_id      TEXT NOT NULL
    REFERENCES households(id) ON DELETE CASCADE,
  goodbye_note      TEXT,
  reason            TEXT NOT NULL DEFAULT 'wilted_too_long',
  departed_at       BIGINT NOT NULL,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  deleted_at        BIGINT,
  CONSTRAINT pet_departures_reason_check
    CHECK (reason IN ('inactivity', 'wilted_too_long', 'user_dismissed'))
);

-- Delta-sync feed for Menagerie. NOT partial: clients must learn about
-- tombstones (rows with deleted_at set) to mirror them locally. Matches
-- the journal-entries delta-sync index from migration 0011.
CREATE INDEX IF NOT EXISTS idx_pet_departures_household_updated
  ON pet_departures (household_id, updated_at DESC);

-- "Departed" section query: most-recent-first within a household.
-- Partial because tombstoned departures shouldn't appear in the UI.
CREATE INDEX IF NOT EXISTS idx_pet_departures_household_departed
  ON pet_departures (household_id, departed_at DESC)
  WHERE deleted_at IS NULL;
