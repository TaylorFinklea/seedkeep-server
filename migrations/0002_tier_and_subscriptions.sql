-- F2: tier + subscriptions schema.
--
-- Adds a `tier` column to `user` so the extraction route can branch on
-- the user's plan, and a `subscriptions` table to track Apple IAP
-- receipts for users on the hosted tier.
--
-- The `byok` tier is set when a user pastes their own OpenAI/Anthropic
-- key in iOS Settings. Keys themselves never live on the server — they
-- stay in the iOS Keychain. The server just knows the user is "BYOK"
-- so it can permit pre-extracted JSON uploads instead of requiring a
-- subscription.

-- ── users.tier ──────────────────────────────────────────────────────────────

ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'free'
    CHECK (tier IN ('free', 'byok', 'hosted'));

CREATE INDEX IF NOT EXISTS idx_user_tier ON "user"(tier);

-- ── subscriptions ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS subscriptions (
  -- Surrogate primary key (nanoid client-generated).
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  -- Apple App Store product identifier (e.g., 'com.example.seedkeep.hosted.monthly').
  product_id TEXT NOT NULL,
  -- Apple's `original_transaction_id` is the stable identifier across
  -- renewals; per-renewal IDs go in `latest_transaction_id` instead.
  original_transaction_id TEXT NOT NULL UNIQUE,
  latest_transaction_id TEXT NOT NULL,
  -- Receipt data (base64 PKCS#7 from StoreKit). Stored so we can
  -- re-verify against Apple if our cached state goes stale.
  receipt_data TEXT NOT NULL,
  -- Subscription state — drives the `users.tier` flip and feature gates.
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired', 'cancelled', 'refunded')),
  expires_at BIGINT NOT NULL,
  -- Last time we round-tripped Apple's verifyReceipt endpoint. Used by
  -- a future cron to re-verify receipts before they expire.
  last_verified_at BIGINT NOT NULL,
  -- Apple's environment for the receipt (sandbox during testing,
  -- production live).
  environment TEXT NOT NULL DEFAULT 'production'
    CHECK (environment IN ('production', 'sandbox')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_orig ON subscriptions(original_transaction_id);
