-- Fix the better-auth tables to use TIMESTAMPTZ instead of BIGINT.
--
-- The initial migration converted every timestamp column from the
-- Workers/D1 SQLite era to BIGINT (ms-since-epoch) for consistency
-- with the domain tables. That works for our hand-written code, but
-- breaks better-auth: the library's Kysely-Postgres dialect writes
-- native JavaScript Date values, which Postgres tries to coerce to
-- `timestamp with time zone` and rejects against a BIGINT column.
-- The first sign-in attempt surfaces this as a "column createdAt
-- is of type bigint but expression is of type timestamp with time
-- zone" error in the better-auth logs and an empty-token response
-- to the iOS client.
--
-- Scope: only the four tables better-auth owns. Domain tables stay
-- BIGINT — our own writers send BIGINT and our readers expect
-- BIGINT, no mismatch there.
--
-- The `USING to_timestamp(col / 1000.0)` casts handle the case where
-- earlier rows already landed before the failure surfaced. For an
-- empty table they're no-ops.

ALTER TABLE "user"
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING to_timestamp("createdAt" / 1000.0),
  ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ USING to_timestamp("updatedAt" / 1000.0);

ALTER TABLE session
  ALTER COLUMN "expiresAt" TYPE TIMESTAMPTZ USING to_timestamp("expiresAt" / 1000.0),
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING to_timestamp("createdAt" / 1000.0),
  ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ USING to_timestamp("updatedAt" / 1000.0);

ALTER TABLE account
  ALTER COLUMN "accessTokenExpiresAt" TYPE TIMESTAMPTZ
    USING CASE WHEN "accessTokenExpiresAt" IS NULL THEN NULL
               ELSE to_timestamp("accessTokenExpiresAt" / 1000.0) END,
  ALTER COLUMN "refreshTokenExpiresAt" TYPE TIMESTAMPTZ
    USING CASE WHEN "refreshTokenExpiresAt" IS NULL THEN NULL
               ELSE to_timestamp("refreshTokenExpiresAt" / 1000.0) END,
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING to_timestamp("createdAt" / 1000.0),
  ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ USING to_timestamp("updatedAt" / 1000.0);

ALTER TABLE verification
  ALTER COLUMN "expiresAt" TYPE TIMESTAMPTZ USING to_timestamp("expiresAt" / 1000.0),
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING to_timestamp("createdAt" / 1000.0),
  ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ
    USING CASE WHEN "updatedAt" IS NULL THEN NULL
               ELSE to_timestamp("updatedAt" / 1000.0) END;
