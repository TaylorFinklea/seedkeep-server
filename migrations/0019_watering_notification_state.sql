-- Migration: Household-scoped watering-notification ledger.
--
-- Phase 4C ships native watering reminders. Frost + heat warnings stay
-- per-device (acceptable date-anchored redundancy across the same iCloud
-- account), but watering reminders coalesce across devices via a single
-- server-authoritative timestamp on each household row.
--
-- Nullable on purpose: existing rows default to NULL = eligible to fire
-- immediately. No downstream consumer existed before this phase, so no
-- backfill is needed.

ALTER TABLE households
  ADD COLUMN IF NOT EXISTS last_watering_notification_at TIMESTAMPTZ NULL;
