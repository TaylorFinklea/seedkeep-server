-- Add an exclusive server-side lease for irreversible source-zone deletion.
--
-- `source_deleting` is the owner's exclusive lease to destroy the only copy
-- of the garden. Without this phase, a concurrent cancellation or successor
-- departure between the phase read and the CloudKit delete can destroy the
-- source with no route to `source_deleted`.
--
-- Retry safety: the runner (src/db/migrate.ts) applies each file and its
-- ledger row inside ONE transaction, and Postgres DDL is transactional, so
-- a failed 0027 leaves neither the column, nor the constraint, nor the
-- ledger entry behind. A re-run therefore always starts from the state
-- before the first attempt. The statements below are independently
-- re-runnable anyway — `ADD COLUMN IF NOT EXISTS`, and a `DROP CONSTRAINT
-- IF EXISTS` immediately before the `ADD CONSTRAINT` that replaces it.
-- Nothing here needs a `DO` block or a pg_constraint probe.

ALTER TABLE account_deletion_transfers
    ADD COLUMN IF NOT EXISTS source_deleting_at BIGINT;

ALTER TABLE account_deletion_transfers
    DROP CONSTRAINT IF EXISTS account_deletion_transfers_phase_check;

ALTER TABLE account_deletion_transfers
    ADD CONSTRAINT account_deletion_transfers_phase_check CHECK (phase IN (
        'pending_successor',
        'successor_bound',
        'destination_ready',
        'owner_verified',
        'verified',
        'source_deleting',
        'source_deleted',
        'cancelled'
    ));
