-- Seedkeep initial schema for PostgreSQL.
--
-- Re-authored from the Workers/D1 SQLite version (preserved at
-- ~/git/seedkeep tag phase-1-workers-attempt). Differences:
--   - `INTEGER` for ms-epoch timestamps becomes `BIGINT` (32-bit overflows).
--   - `"user"` and the better-auth camelCase columns are quoted.
--   - `unixepoch() * 1000` defaults move to `(extract(epoch from now()) * 1000)::bigint`.
--   - Partial-index `WHERE` clauses port over verbatim.
--   - JSON aggregation in seed listing uses `array_agg` (in `routes/seeds.ts`),
--     not `json_group_array`.
--
-- Two layers:
--   1. better-auth tables ("user", session, account, verification).
--   2. Per-household domain (households, locations, tags, seeds, etc.) with
--      `household_id` as the leading column on every index — substitute for
--      missing native row-level security at the API layer.
-- Plus the global catalog tables (catalog_seeds, catalog_extractions).

-- ── better-auth tables ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "user" (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT UNIQUE,
  "emailVerified" BOOLEAN NOT NULL DEFAULT FALSE,
  image TEXT,
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  "expiresAt" BIGINT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL,
  FOREIGN KEY ("userId") REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_user ON session("userId");
CREATE INDEX IF NOT EXISTS idx_session_token ON session(token);

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" BIGINT,
  "refreshTokenExpiresAt" BIGINT,
  scope TEXT,
  password TEXT,
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT NOT NULL,
  FOREIGN KEY ("userId") REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_user ON account("userId");
CREATE INDEX IF NOT EXISTS idx_account_provider ON account("providerId", "accountId");

CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  "expiresAt" BIGINT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT
);

-- ── households + memberships ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT
);

CREATE TABLE IF NOT EXISTS memberships (
  household_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at BIGINT NOT NULL,
  PRIMARY KEY (household_id, user_id),
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  claimed_by TEXT,
  claimed_at BIGINT,
  created_at BIGINT NOT NULL,
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by) REFERENCES "user"(id) ON DELETE CASCADE,
  FOREIGN KEY (claimed_by) REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_invites_household ON invites(household_id);
CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code);

-- ── locations + tags ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_locations_household ON locations(household_id, deleted_at);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tags_household ON tags(household_id, deleted_at);

-- ── catalog (global) ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS catalog_seeds (
  id TEXT PRIMARY KEY,
  barcode TEXT,
  perceptual_hash TEXT,
  common_name TEXT NOT NULL,
  variety TEXT,
  company TEXT,
  -- Free-text planting instructions extracted from the packet.
  instructions TEXT,
  viability_years INTEGER,
  -- Moderation lifecycle: pending review → published or rejected.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'rejected')),
  -- Confidence score from the AI reviewer pass (0..1).
  confidence REAL,
  -- ID of the household whose extraction created this row, for attribution + audit.
  origin_household_id TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  published_at BIGINT,
  FOREIGN KEY (origin_household_id) REFERENCES households(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_catalog_seeds_barcode ON catalog_seeds(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_catalog_seeds_hash ON catalog_seeds(perceptual_hash) WHERE perceptual_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_catalog_seeds_status ON catalog_seeds(status);

CREATE TABLE IF NOT EXISTS catalog_extractions (
  id TEXT PRIMARY KEY,
  catalog_seed_id TEXT,
  submitted_by_household TEXT NOT NULL,
  submitted_by_user TEXT NOT NULL,
  vision_model_id TEXT NOT NULL,
  vision_model_version TEXT,
  raw_extraction TEXT NOT NULL,           -- JSON blob from the vision model
  review_model_id TEXT,
  review_model_version TEXT,
  review_score REAL,
  review_notes TEXT,
  source_photo_keys TEXT NOT NULL,        -- JSON array of storage keys
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'failed')),
  created_at BIGINT NOT NULL,
  reviewed_at BIGINT,
  FOREIGN KEY (catalog_seed_id) REFERENCES catalog_seeds(id) ON DELETE SET NULL,
  FOREIGN KEY (submitted_by_household) REFERENCES households(id) ON DELETE CASCADE,
  FOREIGN KEY (submitted_by_user) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_extractions_catalog ON catalog_extractions(catalog_seed_id);
CREATE INDEX IF NOT EXISTS idx_extractions_household ON catalog_extractions(submitted_by_household, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_extractions_status ON catalog_extractions(status);

-- ── seeds (per-household) + photos + tags-join ──────────────────────────────

CREATE TABLE IF NOT EXISTS seeds (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  catalog_id TEXT,                         -- NULL while extraction is pending
  state TEXT NOT NULL CHECK (state IN ('active', 'wishlist', 'saved', 'archived')),
  packet_count INTEGER NOT NULL DEFAULT 1,
  location_id TEXT,
  year_packed INTEGER,
  source TEXT NOT NULL DEFAULT 'store' CHECK (source IN ('store', 'saved', 'gift', 'swap')),
  custom_name TEXT,                        -- Override common_name from catalog
  custom_variety TEXT,
  custom_company TEXT,
  notes TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  FOREIGN KEY (catalog_id) REFERENCES catalog_seeds(id) ON DELETE SET NULL,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_seeds_household_state ON seeds(household_id, state, deleted_at);
CREATE INDEX IF NOT EXISTS idx_seeds_household_updated ON seeds(household_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_seeds_catalog ON seeds(catalog_id);

CREATE TABLE IF NOT EXISTS seed_photos (
  id TEXT PRIMARY KEY,
  seed_id TEXT NOT NULL,
  household_id TEXT NOT NULL,              -- denormalized for the household-scoped middleware
  -- Object storage key. Named `r2_key` for backwards-compat with the iOS
  -- client's wire DTO; the value is portable across any S3-compatible store.
  r2_key TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'extra' CHECK (role IN ('front', 'back', 'extra')),
  width INTEGER,
  height INTEGER,
  byte_size INTEGER,
  captured_at BIGINT NOT NULL,
  FOREIGN KEY (seed_id) REFERENCES seeds(id) ON DELETE CASCADE,
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_seed_photos_seed ON seed_photos(seed_id);
CREATE INDEX IF NOT EXISTS idx_seed_photos_household ON seed_photos(household_id);

CREATE TABLE IF NOT EXISTS seed_tags (
  seed_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  household_id TEXT NOT NULL,
  PRIMARY KEY (seed_id, tag_id),
  FOREIGN KEY (seed_id) REFERENCES seeds(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE,
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_seed_tags_household_tag ON seed_tags(household_id, tag_id);
