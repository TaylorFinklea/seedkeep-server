-- Migration: Horticultural data fields on catalog_seeds.
--
-- The original catalog schema carried only the marketing-text fields
-- (common name, variety, company, instructions). For Phase 2 garden
-- planning to actually work — frost-aware planting calendars, bed
-- spacing validation, seed-depth guidance at planting time — the
-- catalog needs structured horticultural data alongside the prose.
--
-- All fields are nullable so existing pending/published rows survive
-- the migration unchanged. Enum-shaped fields use CHECK constraints
-- (cheaper to evolve than PG enums; we may add values like
-- 'semi-hardy' later).
--
-- Ranges are stored as two columns (min/max) rather than a Postgres
-- range type — simpler to read, simpler to filter by in the iOS
-- client, and avoids the range-bound semantics confusion.

ALTER TABLE catalog_seeds
  ADD COLUMN IF NOT EXISTS scientific_name TEXT,
  ADD COLUMN IF NOT EXISTS days_to_germinate_min INT,
  ADD COLUMN IF NOT EXISTS days_to_germinate_max INT,
  ADD COLUMN IF NOT EXISTS days_to_maturity_min INT,
  ADD COLUMN IF NOT EXISTS days_to_maturity_max INT,
  ADD COLUMN IF NOT EXISTS soil_temp_min_f INT,
  ADD COLUMN IF NOT EXISTS soil_temp_max_f INT,
  ADD COLUMN IF NOT EXISTS seed_depth_inches NUMERIC(3,2),
  ADD COLUMN IF NOT EXISTS plant_spacing_inches INT,
  ADD COLUMN IF NOT EXISTS row_spacing_inches INT,
  ADD COLUMN IF NOT EXISTS sun_requirement TEXT
    CHECK (sun_requirement IS NULL OR sun_requirement IN ('full', 'partial', 'shade')),
  ADD COLUMN IF NOT EXISTS frost_tolerance TEXT
    CHECK (frost_tolerance IS NULL OR frost_tolerance IN ('tender', 'half_hardy', 'hardy')),
  ADD COLUMN IF NOT EXISTS sow_method TEXT
    CHECK (sow_method IS NULL OR sow_method IN ('direct', 'transplant', 'either')),
  ADD COLUMN IF NOT EXISTS life_cycle TEXT
    CHECK (life_cycle IS NULL OR life_cycle IN ('annual', 'biennial', 'perennial')),
  ADD COLUMN IF NOT EXISTS hardiness_zone_min INT,
  ADD COLUMN IF NOT EXISTS hardiness_zone_max INT;

-- Indexable filters for common Phase 2 garden-plan queries: "what can I
-- plant in zone 6 right now?" hits hardiness + sun + frost together.
CREATE INDEX IF NOT EXISTS idx_catalog_sun_requirement ON catalog_seeds(sun_requirement)
  WHERE sun_requirement IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_catalog_frost_tolerance ON catalog_seeds(frost_tolerance)
  WHERE frost_tolerance IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_catalog_life_cycle ON catalog_seeds(life_cycle)
  WHERE life_cycle IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_catalog_scientific_name ON catalog_seeds(scientific_name)
  WHERE scientific_name IS NOT NULL;
