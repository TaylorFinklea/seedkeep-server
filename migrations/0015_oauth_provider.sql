-- Phase 4 E (continued) · OAuth 2.1 + DCR for MCP, courtesy of
-- better-auth's `oidc-provider` and `mcp` plugins.
--
-- Tables match better-auth's required schema for the OIDC provider
-- plugin (oauthApplication / oauthAccessToken / oauthConsent). The
-- `web_pairing_codes` table is ours — it carries the device-pairing
-- flow that bridges an iOS session to a browser session so the user
-- can complete the OAuth consent without a separate web sign-in.

-- ── better-auth: dynamic-client-registration registry ───────────────
CREATE TABLE IF NOT EXISTS "oauthApplication" (
    id              TEXT PRIMARY KEY,
    "clientId"      TEXT UNIQUE NOT NULL,
    "clientSecret"  TEXT,
    type            TEXT NOT NULL,
    name            TEXT NOT NULL,
    icon            TEXT,
    metadata        TEXT,
    disabled        BOOLEAN DEFAULT FALSE,
    "redirectUrls"  TEXT NOT NULL,
    "userId"        TEXT REFERENCES "user"(id) ON DELETE CASCADE,
    "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "oauthApplication_userId_idx"
    ON "oauthApplication"("userId");

-- ── better-auth: issued access + refresh tokens ─────────────────────
CREATE TABLE IF NOT EXISTS "oauthAccessToken" (
    id                       TEXT PRIMARY KEY,
    "accessToken"            TEXT UNIQUE NOT NULL,
    "refreshToken"           TEXT UNIQUE NOT NULL,
    "accessTokenExpiresAt"   TIMESTAMPTZ NOT NULL,
    "refreshTokenExpiresAt"  TIMESTAMPTZ NOT NULL,
    "clientId"               TEXT NOT NULL REFERENCES "oauthApplication"("clientId") ON DELETE CASCADE,
    "userId"                 TEXT REFERENCES "user"(id) ON DELETE CASCADE,
    scopes                   TEXT NOT NULL,
    "createdAt"              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt"              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "oauthAccessToken_clientId_idx"
    ON "oauthAccessToken"("clientId");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_userId_idx"
    ON "oauthAccessToken"("userId");

-- ── better-auth: per-(client, user) consent grants ──────────────────
CREATE TABLE IF NOT EXISTS "oauthConsent" (
    id              TEXT PRIMARY KEY,
    "clientId"      TEXT NOT NULL REFERENCES "oauthApplication"("clientId") ON DELETE CASCADE,
    "userId"        TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    scopes          TEXT NOT NULL,
    "consentGiven"  BOOLEAN NOT NULL,
    "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "oauthConsent_clientId_idx"
    ON "oauthConsent"("clientId");
CREATE INDEX IF NOT EXISTS "oauthConsent_userId_idx"
    ON "oauthConsent"("userId");

-- ── Web pairing codes (Seedkeep-specific) ───────────────────────────
-- iOS app mints a short code; user types it on the OAuth login page
-- in their browser to establish a web session. Replaces the missing
-- web Sign-in-with-Apple flow.
CREATE TABLE IF NOT EXISTS web_pairing_codes (
    code            TEXT PRIMARY KEY CHECK (length(code) BETWEEN 6 AND 16),
    user_id         TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    household_id    TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    expires_at      BIGINT NOT NULL,
    used_at         BIGINT
);
CREATE INDEX IF NOT EXISTS web_pairing_codes_user_idx
    ON web_pairing_codes(user_id);
