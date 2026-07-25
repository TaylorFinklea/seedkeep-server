-- Make a verified account-deletion transfer reversible.
--
-- Successor verification promotes the successor to owner of the source
-- household (0025), but cancellation stays legal right up until the
-- source zone is deleted. Without a record of what the successor's
-- membership looked like *before* the handoff, cancelling leaves them
-- permanently promoted — an abandoned handoff would silently hand away
-- server authority over the garden.
--
-- Captured at re-home time, consumed on cancellation:
--   'absent' — the successor had no membership; the transfer created it
--              (the usual case: CKShare participants are not members)
--   'member' — demote back to member
--   'owner'  — already an owner; cancellation must leave them alone

ALTER TABLE account_deletion_transfers
    ADD COLUMN IF NOT EXISTS successor_prior_membership TEXT
        CHECK (successor_prior_membership IS NULL
               OR successor_prior_membership IN ('absent', 'member', 'owner'));
