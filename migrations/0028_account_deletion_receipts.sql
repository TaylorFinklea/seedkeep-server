-- Durable capability receipts make final account deletion recoverable after
-- the response is lost and the deleting session has cascaded away.

CREATE TABLE IF NOT EXISTS account_deletion_receipts (
    receipt_hash    TEXT PRIMARY KEY,
    -- LOAD-BEARING: deliberately NO foreign key. This row must outlive the
    -- deleted user so an unauthenticated client can recover the result.
    deleted_user_id TEXT NOT NULL,
    deleted_at      BIGINT NOT NULL,
    expires_at      BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS account_deletion_receipts_expires_idx
    ON account_deletion_receipts(expires_at);
