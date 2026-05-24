-- 0010: Make the calendar-change trigger NULL-safe.
--
-- Before this migration, `invalidate_recommendation_on_calendar()` ran:
--   DELETE FROM recommendation_cache WHERE region_id IN (OLD.region_id, NEW.region_id);
--
-- SQL three-valued logic means `IN (NULL, 'KS')` does NOT match rows where
-- `region_id IS NULL` — so any cache row written *before* migration 0009 added
-- the region_id column (i.e. rule-engine results from before extension
-- calendars existed) survived a subsequent calendar rollout. The result was
-- that early-adopter households kept seeing stale rule-engine recommendations
-- even after extension data for their region was published. We hit this
-- in production on 2026-05-23 when KS was added and Taylor's pre-extension
-- pepper row was masking the new KS extension result.
--
-- Two-part fix in this migration:
--   1. Trigger rewritten to also delete rows where `region_id IS NULL`
--      whenever any calendar row changes — costs at most one extra scan over
--      the legacy stragglers; pure win after the first run since they all get
--      wiped.
--   2. One-shot DELETE of the surviving stale rows. We ran this against prod
--      manually before this migration was written, so the migration's DELETE
--      is a defensive no-op on the deployed DB but matters for every staging
--      or self-hosted copy that hasn't been cleaned.
--
-- The companion code change (src/lib/recommendation/locationSignature.ts)
-- now includes `region_id` in the cache key, so even if this trigger ever
-- misses a row again, the next request rebuilds a fresh signature and
-- forces a cache miss → re-compute → extension consulted. Belt + suspenders.

CREATE OR REPLACE FUNCTION invalidate_recommendation_on_calendar()
RETURNS trigger AS $$
BEGIN
  DELETE FROM recommendation_cache
   WHERE region_id IS NULL
      OR region_id = OLD.region_id
      OR region_id = NEW.region_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- One-shot cleanup of pre-0009 stragglers. Idempotent (subsequent runs hit
-- zero rows). Safe — every deleted row re-caches on the next request, this
-- time consulting extension calendars.
DELETE FROM recommendation_cache WHERE region_id IS NULL;
