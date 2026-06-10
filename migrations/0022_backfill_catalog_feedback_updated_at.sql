-- Migration: backfill catalog_feedback.updated_at for pre-0020 rows.
--
-- 0020 added `updated_at BIGINT NOT NULL DEFAULT 0` with no backfill, so
-- every feedback row that existed before Phase 4D sits at updated_at=0.
-- GET /api/catalog/corrections/mine is a strict `updated_at > since`
-- cursor feed with since >= 0, so those rows are invisible even on a
-- full first pull. Backfill from created_at (NOT NULL since 0013).
--
-- Idempotent: re-runs match zero rows (created_at is never 0).

UPDATE catalog_feedback SET updated_at = created_at WHERE updated_at = 0;
