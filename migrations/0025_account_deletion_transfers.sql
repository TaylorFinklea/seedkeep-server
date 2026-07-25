-- CloudKit account-deletion transfers.
--
-- A shared-garden owner cannot simply delete their account: the CKShare's
-- record zone belongs to them, so deleting it would take the whole garden
-- away from the participants. Instead the owner hands the garden to a
-- successor, who builds their own destination zone and share, and both
-- devices prove the copy is complete before the source is destroyed.
--
-- This table is the durable coordinator for that two-device dance. The
-- server never sees garden record contents — only the parties, the zone
-- and share identifiers, canonical digests with per-type counts, the
-- hashed handoff token, the phase, and timestamps.
--
-- Phase machine (spec § "Shared owner"):
--
--   pending_successor  → successor_bound  → destination_ready
--     → owner_verified → verified         → source_deleted
--
-- Any non-`source_deleted` phase may move to `cancelled`; `source_deleted`
-- is terminal and is the only phase from which `DELETE /api/me` accepts a
-- shared owner.

CREATE TABLE IF NOT EXISTS account_deletion_transfers (
    id                            TEXT PRIMARY KEY,

    -- Parties. Deleting either account tears the coordination down: the
    -- owner's row disappears with them, a departing successor unbinds and
    -- leaves the owner free to cancel and restart.
    source_household_id           TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    owner_user_id                 TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    successor_user_id             TEXT REFERENCES "user"(id) ON DELETE SET NULL,

    -- SHA-256 hex digest of a random 256-bit base64url handoff token. The
    -- raw value is returned exactly once at creation and never stored.
    handoff_token_hash            TEXT NOT NULL UNIQUE,
    handoff_expires_at            BIGINT NOT NULL,
    -- Set when the token is spent. Single use: acceptance is only legal
    -- from `pending_successor`, so a replayed token finds a bound row.
    handoff_consumed_at           BIGINT,

    phase                         TEXT NOT NULL CHECK (phase IN (
                                      'pending_successor',
                                      'successor_bound',
                                      'destination_ready',
                                      'owner_verified',
                                      'verified',
                                      'source_deleted',
                                      'cancelled'
                                  )),

    -- Successor-owned destination. Identifiers only — no record contents.
    destination_zone_name         TEXT,
    destination_zone_owner_name   TEXT,
    destination_share_record_name TEXT,
    destination_share_url         TEXT,

    -- { digest, record_counts, submitted_at }. The source zone may not be
    -- deleted until these two documents agree.
    owner_digest                  JSONB,
    successor_digest              JSONB,

    created_at                    BIGINT NOT NULL,
    updated_at                    BIGINT NOT NULL,
    cancelled_at                  BIGINT,

    -- A garden cannot be handed to the person handing it over.
    CONSTRAINT account_deletion_transfers_successor_not_owner
        CHECK (successor_user_id IS NULL OR successor_user_id <> owner_user_id)
);

-- One active transfer per owner. Cancelled rows stay for the audit trail
-- and free the owner to start over.
CREATE UNIQUE INDEX IF NOT EXISTS account_deletion_transfers_active_owner_idx
    ON account_deletion_transfers(owner_user_id)
    WHERE phase <> 'cancelled';

-- The successor's app resumes by transfer id, but the accept handler and
-- membership re-home both look the row up by party.
CREATE INDEX IF NOT EXISTS account_deletion_transfers_successor_idx
    ON account_deletion_transfers(successor_user_id)
    WHERE successor_user_id IS NOT NULL;
