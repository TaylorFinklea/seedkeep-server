-- Migration: Recommendation cache + async AI fill-in queue.
--
-- recommendation_cache stores the season-stable baseline ONLY
-- (window dates, confidence, source). verdict and the 60-day
-- suitability scores are projected per-request from window + today,
-- so the cache never goes stale as days pass. It is invalidated
-- only by catalog horticultural changes or household location
-- changes — handled by the triggers below.

CREATE TABLE IF NOT EXISTS recommendation_cache (
  catalog_seed_id    TEXT NOT NULL REFERENCES catalog_seeds(id) ON DELETE CASCADE,
  location_signature TEXT NOT NULL,
  computed_at        BIGINT NOT NULL,
  source             TEXT NOT NULL CHECK (source IN ('rule','ai')),
  confidence         NUMERIC(3,2) NOT NULL,
  window_start       TEXT,                 -- 'YYYY-MM-DD' (null = no window)
  window_end         TEXT,
  indoor_start       TEXT,                 -- transplant varieties only
  indoor_end         TEXT,
  reasoning          TEXT,
  inputs_used        TEXT NOT NULL,        -- JSON array of strings
  PRIMARY KEY (catalog_seed_id, location_signature)
);

CREATE TABLE IF NOT EXISTS recommendation_jobs (
  id                 TEXT PRIMARY KEY,
  catalog_seed_id    TEXT NOT NULL REFERENCES catalog_seeds(id) ON DELETE CASCADE,
  location_signature TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','running','done','failed')),
  attempts           INT NOT NULL DEFAULT 0,
  last_error         TEXT,
  created_at         BIGINT NOT NULL,
  UNIQUE (catalog_seed_id, location_signature)
);

CREATE INDEX IF NOT EXISTS idx_recommendation_jobs_pending
  ON recommendation_jobs(created_at) WHERE status = 'pending';

-- Trigger: a catalog horticultural change wipes that seed's cached rows.
CREATE OR REPLACE FUNCTION invalidate_recommendation_on_catalog()
RETURNS trigger AS $$
BEGIN
  DELETE FROM recommendation_cache WHERE catalog_seed_id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_catalog_invalidates_recommendation ON catalog_seeds;
CREATE TRIGGER trg_catalog_invalidates_recommendation
  AFTER UPDATE ON catalog_seeds
  FOR EACH ROW
  WHEN (
    OLD.frost_tolerance       IS DISTINCT FROM NEW.frost_tolerance OR
    OLD.sow_method            IS DISTINCT FROM NEW.sow_method OR
    OLD.soil_temp_min_f       IS DISTINCT FROM NEW.soil_temp_min_f OR
    OLD.soil_temp_max_f       IS DISTINCT FROM NEW.soil_temp_max_f OR
    OLD.days_to_germinate_min IS DISTINCT FROM NEW.days_to_germinate_min OR
    OLD.days_to_germinate_max IS DISTINCT FROM NEW.days_to_germinate_max OR
    OLD.days_to_maturity_min  IS DISTINCT FROM NEW.days_to_maturity_min OR
    OLD.days_to_maturity_max  IS DISTINCT FROM NEW.days_to_maturity_max OR
    OLD.hardiness_zone_min    IS DISTINCT FROM NEW.hardiness_zone_min OR
    OLD.hardiness_zone_max    IS DISTINCT FROM NEW.hardiness_zone_max
  )
  EXECUTE FUNCTION invalidate_recommendation_on_catalog();

-- Trigger: a household location change wipes cached rows for that zone.
-- Matching by zone prefix over-invalidates slightly (other households in
-- the zone) — safe, since the only consequence is a recompute, and
-- household location changes are rare.
CREATE OR REPLACE FUNCTION invalidate_recommendation_on_household()
RETURNS trigger AS $$
BEGIN
  DELETE FROM recommendation_cache
   WHERE (OLD.usda_zone IS NOT NULL AND location_signature LIKE OLD.usda_zone || ':%')
      OR (NEW.usda_zone IS NOT NULL AND location_signature LIKE NEW.usda_zone || ':%');
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
    OLD.longitude       IS DISTINCT FROM NEW.longitude
  )
  EXECUTE FUNCTION invalidate_recommendation_on_household();
