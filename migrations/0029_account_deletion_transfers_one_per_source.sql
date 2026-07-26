-- One live handoff per garden, not just per owner.
--
-- 0025 made `account_deletion_transfers_active_owner_idx` unique on the
-- owner, which stops one person starting two handoffs. It does not stop
-- two *co-owners* of the same household each starting one: two successors
-- would then be re-homed into the same source and each could drive it to
-- `source_deleted`, unlocking two account deletions against one garden.
--
-- The source household is the thing being handed over, so that is what
-- has to be unique. Cancelled rows stay for the audit trail and free the
-- garden to be handed over again.

CREATE UNIQUE INDEX IF NOT EXISTS account_deletion_transfers_active_source_idx
    ON account_deletion_transfers(source_household_id)
    WHERE phase <> 'cancelled';
