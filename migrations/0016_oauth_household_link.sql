-- Phase 4 E (continued) · Pin the household choice from the iOS pairing
-- code so it survives the OAuth exchange.
--
-- Background: better-auth's `oauthAccessToken` carries only `userId`
-- (no household scope). `/mcp` previously resolved household from
-- `memberships LIMIT 1` with no `ORDER BY`, so MCP could expose a
-- different household than session-route middleware (which orders by
-- joined_at DESC). For multi-household users this was a cross-household
-- read.
--
-- The pairing code captures the iOS-time `household_id` already; we
-- persist that choice in a user-keyed pin table so it survives the
-- access-token exchange and token-refresh cycles. UPSERT on each pair
-- so the most-recent iOS-time choice wins.

CREATE TABLE IF NOT EXISTS oauth_user_household (
    user_id       TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    updated_at    BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_user_household_household_idx
    ON oauth_user_household(household_id);
