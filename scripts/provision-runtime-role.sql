-- Operator-only provisioning for the website/runtime role.
-- Run after all migrations, including 0030, using the database owner:
--   psql -X -v ON_ERROR_STOP=1 -f scripts/provision-runtime-role.sql
-- Then set the role password interactively with `\password seedkeep_web_runtime`.
-- No password, owner credential, or runtime DDL is stored in this file.
-- Run once; if this role already exists, stop and audit it rather than rerunning.
-- Revisit grants manually for each newly added application table; migrations stay portable.

\set ON_ERROR_STOP on
SELECT current_database() AS database_name \gset
BEGIN;
CREATE ROLE seedkeep_web_runtime
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE :"database_name" TO seedkeep_web_runtime;
GRANT USAGE ON SCHEMA public TO seedkeep_web_runtime;
GRANT SELECT ON TABLE "_seedkeep_migrations" TO seedkeep_web_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "_seedkeep_kv",
  "account",
  "account_deletion_receipts",
  "account_deletion_transfers",
  "assistant_keys",
  "assistant_messages",
  "assistant_threads",
  "assistant_tool_calls",
  "beds",
  "catalog_audit_log",
  "catalog_correction_notifications",
  "catalog_extractions",
  "catalog_feedback",
  "catalog_seeds",
  "crop_aliases",
  "extension_calendar_entries",
  "households",
  "invites",
  "journal_checklist_items",
  "journal_entries",
  "journal_entry_photos",
  "locations",
  "mcp_tokens",
  "memberships",
  "oauthAccessToken",
  "oauthApplication",
  "oauthConsent",
  "oauth_user_household",
  "pet_departures",
  "planting_events",
  "recommendation_cache",
  "recommendation_jobs",
  "regions",
  "seed_photos",
  "seed_tags",
  "seeds",
  "session",
  "subscriptions",
  "tags",
  "user",
  "verification",
  "web_pairing_codes",
  "zip_locations"
TO seedkeep_web_runtime;
COMMIT;
