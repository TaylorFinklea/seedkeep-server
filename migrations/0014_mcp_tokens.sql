-- Phase 4 E · Personal MCP tokens.
--
-- Issued from the iOS app (Settings → AI Assistant → Connect Claude
-- Desktop). Users paste the raw token into their MCP client's config.
-- We store only a SHA-256 hash on the server; the raw value is shown
-- once at creation and never again.

CREATE TABLE IF NOT EXISTS mcp_tokens (
    id            TEXT PRIMARY KEY,
    household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    -- Human-friendly identifier shown in the list ("Claude Desktop",
    -- "Test Mac"). 1-64 chars, defaults to "Untitled".
    label         TEXT NOT NULL DEFAULT 'Untitled' CHECK (length(label) BETWEEN 1 AND 64),
    -- SHA-256 hex digest of the token's raw secret. We compare hashes
    -- on each MCP request — never compare against the raw secret in
    -- prod, and never log it.
    token_hash    TEXT NOT NULL UNIQUE,
    created_at    BIGINT NOT NULL,
    last_used_at  BIGINT,
    revoked_at    BIGINT
);

CREATE INDEX IF NOT EXISTS mcp_tokens_household_idx
    ON mcp_tokens(household_id) WHERE revoked_at IS NULL;
