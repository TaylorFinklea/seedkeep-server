-- Migration: Extension calendars v1 — foundation + Authority.
--
-- Expert-curated regional planting calendars. extension_calendar_entries
-- is keyed by (region, crop, sow_method); a published entry takes
-- precedence over the rule engine. Schema is community-ready (source,
-- status, submitted_by, review columns) though v1 ships only bundled data.
-- Region is a US state code; households.region_id is resolved from the
-- home ZIP. recommendation_cache gains region_id so a calendar change can
-- invalidate every cached row for that region.

CREATE TABLE IF NOT EXISTS regions (
  id           TEXT PRIMARY KEY,        -- state code, e.g. 'VA'
  display_name TEXT NOT NULL,           -- 'Virginia'
  state_code   TEXT NOT NULL,           -- 'VA' (== id for v1 state-level regions)
  description  TEXT,
  created_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS extension_calendar_entries (
  id                 TEXT PRIMARY KEY,
  region_id          TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  crop_key           TEXT NOT NULL,                       -- 'tomato'
  sow_method         TEXT NOT NULL CHECK (sow_method IN ('direct','transplant','either')),
  window_start       TEXT NOT NULL,                       -- 'MM-DD'
  window_end         TEXT NOT NULL,                       -- 'MM-DD'
  indoor_start       TEXT,                                -- 'MM-DD' (transplant only)
  indoor_end         TEXT,
  source             TEXT NOT NULL CHECK (source IN ('bundled','community')),
  source_attribution TEXT NOT NULL,                       -- 'Virginia Cooperative Extension'
  status             TEXT NOT NULL DEFAULT 'published'
                       CHECK (status IN ('published','pending','rejected')),
  submitted_by       TEXT,                                -- household id (null for bundled)
  review_score       NUMERIC(3,2),
  confidence         NUMERIC(3,2),
  notes              TEXT,
  created_at         BIGINT NOT NULL,
  updated_at         BIGINT NOT NULL,
  UNIQUE (region_id, crop_key, sow_method, source)
);

CREATE INDEX IF NOT EXISTS idx_extension_entries_lookup
  ON extension_calendar_entries(region_id, crop_key)
  WHERE status = 'published';

CREATE TABLE IF NOT EXISTS crop_aliases (
  alias    TEXT PRIMARY KEY,   -- normalized lowercase, e.g. 'cherry tomato'
  crop_key TEXT NOT NULL       -- canonical crop, e.g. 'tomato'
);

-- region_id on households / recommendation_cache is intentionally a plain
-- column with no FK to regions(id): a household's region is resolved from its
-- ZIP and may be set before the regions dataset is seeded. The value is a soft
-- denormalized hint; an unknown code simply yields no extension match.
ALTER TABLE households
  ADD COLUMN IF NOT EXISTS region_id TEXT;

ALTER TABLE recommendation_cache
  ADD COLUMN IF NOT EXISTS region_id TEXT;

CREATE INDEX IF NOT EXISTS idx_recommendation_cache_region
  ON recommendation_cache(region_id);

-- Widen the recommendation_cache source enum to admit 'extension'.
-- A CHECK constraint cannot be appended to; drop and recreate it.
ALTER TABLE recommendation_cache
  DROP CONSTRAINT IF EXISTS recommendation_cache_source_check;
ALTER TABLE recommendation_cache
  ADD CONSTRAINT recommendation_cache_source_check
  CHECK (source IN ('rule','ai','extension'));

-- Trigger: a calendar change wipes every cached row for that region.
-- Coarse (whole region, not per-crop) — calendar data changes rarely,
-- so simplicity beats precision. Fires on INSERT/UPDATE/DELETE.
CREATE OR REPLACE FUNCTION invalidate_recommendation_on_calendar()
RETURNS trigger AS $$
BEGIN
  DELETE FROM recommendation_cache
   WHERE region_id IN (OLD.region_id, NEW.region_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_calendar_invalidates_recommendation ON extension_calendar_entries;
CREATE TRIGGER trg_calendar_invalidates_recommendation
  AFTER INSERT OR UPDATE OR DELETE ON extension_calendar_entries
  FOR EACH ROW
  EXECUTE FUNCTION invalidate_recommendation_on_calendar();

-- Extend the household-location trigger to also fire when region_id
-- changes (region is resolved alongside zone/frost at PUT /location time).
CREATE OR REPLACE FUNCTION invalidate_recommendation_on_household()
RETURNS trigger AS $$
BEGIN
  DELETE FROM recommendation_cache
   WHERE (OLD.usda_zone IS NOT NULL AND location_signature LIKE OLD.usda_zone || ':%')
      OR (NEW.usda_zone IS NOT NULL AND location_signature LIKE NEW.usda_zone || ':%')
      OR (OLD.region_id IS NOT NULL AND region_id = OLD.region_id)
      OR (NEW.region_id IS NOT NULL AND region_id = NEW.region_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_household_invalidates_recommendation ON households;
CREATE TRIGGER trg_household_invalidates_recommendation
  AFTER UPDATE ON households
  FOR EACH ROW
  WHEN (
    OLD.usda_zone       IS DISTINCT FROM NEW.usda_zone OR
    OLD.avg_last_frost  IS DISTINCT FROM NEW.avg_last_frost OR
    OLD.avg_first_frost IS DISTINCT FROM NEW.avg_first_frost OR
    OLD.latitude        IS DISTINCT FROM NEW.latitude OR
    OLD.longitude       IS DISTINCT FROM NEW.longitude OR
    OLD.region_id       IS DISTINCT FROM NEW.region_id
  )
  EXECUTE FUNCTION invalidate_recommendation_on_household();
