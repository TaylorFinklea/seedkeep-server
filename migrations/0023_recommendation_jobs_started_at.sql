-- Migration: add started_at to recommendation_jobs for the running-job reaper.
-- The reaper in worker.ts resets rows stuck in 'running' for > 10 min back
-- to 'pending', mirroring the corrections worker's reapOrphanedClaims pattern.
--
-- Additive, idempotent.

ALTER TABLE recommendation_jobs
  ADD COLUMN IF NOT EXISTS started_at BIGINT;
