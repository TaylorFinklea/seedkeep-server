-- Phase 2 foundations: garden beds + planting events.
--
-- A bed is a named, household-scoped space the user grows in. Phase 2A
-- captures only the name + optional dimensions; spatial layout
-- (positions, orientation, sub-rows) lands in Phase 2C. Beds are the
-- container; planting events are the actions inside them.
--
-- A planting event is a single dated action tied to a bed (and
-- optionally to a household seed or a global catalog entry). Kinds:
--   sowing      — direct-sowed or transplanted (single column to keep
--                  the per-event UI uncluttered; method can be inferred
--                  from the catalog's sow_method)
--   transplant  — moved an already-started plant into this bed
--   harvest     — picked from this bed
--   note        — a free-form journal entry tied to the bed
--
-- Both tables follow the same shape as households' other domain tables:
-- household_id is the lead column on every index (substitute for the
-- missing native row-level security), updated_at drives delta-sync,
-- soft-delete via deleted_at instead of DELETE so two-device merges
-- don't lose work.

CREATE TABLE IF NOT EXISTS beds (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  -- Optional dimensions in feet (decimal to allow 4.5 etc.). Both
  -- nullable until Phase 2C spatial layout requires them.
  width_feet NUMERIC(5,2),
  length_feet NUMERIC(5,2),
  -- Sort order within the household — lets the user reorder beds.
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_beds_household_updated
  ON beds(household_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_beds_household_active
  ON beds(household_id, sort_order, name)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS planting_events (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  bed_id TEXT,
  -- Either a household-specific seed (consumes packets), a global
  -- catalog entry (when the user wants to record a generic action),
  -- or neither (e.g. a "till and amend" note that's bed-only).
  seed_id TEXT,
  catalog_seed_id TEXT,
  kind TEXT NOT NULL
    CHECK (kind IN ('sowing', 'transplant', 'harvest', 'note')),
  -- Date the action is planned for / occurred on. Stored as a JSON
  -- yyyy-mm-dd string; we don't need timezone semantics for a garden
  -- plan and clients compute relative timing client-side anyway.
  planned_for DATE NOT NULL,
  -- Set when the user marks the event as done. ms-epoch like every
  -- other timestamp in the domain.
  completed_at BIGINT,
  notes TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  FOREIGN KEY (bed_id) REFERENCES beds(id) ON DELETE SET NULL,
  FOREIGN KEY (seed_id) REFERENCES seeds(id) ON DELETE SET NULL,
  FOREIGN KEY (catalog_seed_id) REFERENCES catalog_seeds(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_planting_events_household_updated
  ON planting_events(household_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_planting_events_bed
  ON planting_events(bed_id, planned_for)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_planting_events_seed
  ON planting_events(seed_id)
  WHERE deleted_at IS NULL AND seed_id IS NOT NULL;
