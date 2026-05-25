-- Run against any DB upgraded from a pre-0011 state to verify migration
-- 0011 preserved all kind='note' planting_events as journal_entries.
--
-- Usage:
--   docker exec seedkeep-db psql -U seedkeep -d seedkeep \
--     -f scripts/lib/verify-migration-0011.sql
--
-- Expected (post-migration): legacy_count == preserved_count, unsoftdeleted_count == 0.
-- A fresh DB with no pre-0011 note events will show all three as 0 — also valid.

SELECT
  (SELECT count(*) FROM planting_events WHERE kind = 'note') AS legacy_count,
  (SELECT count(*) FROM journal_entries je
     JOIN planting_events pe ON pe.id = je.id
    WHERE pe.kind = 'note') AS preserved_count,
  (SELECT count(*) FROM planting_events WHERE kind = 'note' AND deleted_at IS NULL)
    AS unsoftdeleted_count;
