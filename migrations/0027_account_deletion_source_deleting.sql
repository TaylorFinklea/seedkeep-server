-- Add an exclusive server-side lease for irreversible source-zone deletion.
--
-- `source_deleting` is the owner's exclusive lease to destroy the only copy
-- of the garden. Without this phase, a concurrent cancellation or successor
-- departure between the phase read and the CloudKit delete can destroy the
-- source with no route to `source_deleted`.

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
