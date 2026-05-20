-- Migration: Household location via home ZIP code.
--
-- The recommendation engine needs each household's USDA zone and
-- average frost dates. zip_locations is a static reference table
-- (loaded by scripts/seed-zip-locations.ts from data/zip_locations.csv).
-- The resolved values are denormalized onto households so the
-- recommendation hot path is a single-row read.

CREATE TABLE IF NOT EXISTS zip_locations (
  zip             TEXT PRIMARY KEY,
  latitude        NUMERIC(8,5) NOT NULL,
  longitude       NUMERIC(8,5) NOT NULL,
  usda_zone       TEXT NOT NULL,        -- e.g. '7a'
  avg_last_frost  TEXT NOT NULL,        -- 'MM-DD'
  avg_first_frost TEXT NOT NULL         -- 'MM-DD'
);

ALTER TABLE households
  ADD COLUMN IF NOT EXISTS home_zip        TEXT,
  ADD COLUMN IF NOT EXISTS latitude        NUMERIC(8,5),
  ADD COLUMN IF NOT EXISTS longitude       NUMERIC(8,5),
  ADD COLUMN IF NOT EXISTS usda_zone       TEXT,
  ADD COLUMN IF NOT EXISTS avg_last_frost  TEXT,
  ADD COLUMN IF NOT EXISTS avg_first_frost TEXT;
