# Current State

## Branch

`main`

## Plan

- [x] `seedkeep-27d.12` Task 1 server state machine: migrations 0025/0026 + authenticated transfer routes + typed final-delete disposition (`9fa6ac5`, review fixes `712bacf`). Sol adversarial re-review CLEAN. Full gate: 322 unit + 199 integration, typecheck clean. **DO NOT DEPLOY** until iOS Tasks 3–5 send `cloudkit_disposition`.
- [x] `seedkeep-27d.12` Task 4 hardening extended the server contract (`addcd5f`, enumeration fix `6e80dac`): atomic `source_deleting` lease, cancellation fence, non-consuming handoff inspection, token rotation, hashed deletion receipts and unauthenticated committed-delete lookup. Sol review CLEAN. Fresh gate: typecheck + 322 unit + 221 integration. **DO NOT DEPLOY** until Task 5 iOS UI ships the full contract.
- [x] Task 5 exact-household contract (`7ea703a`): authenticated `GET /api/households/:id`, membership non-enumeration, deterministic generic-household ordering. Matching iOS handoff UI is complete. Fresh gate: typecheck + 322 unit + 228 integration.
- [x] Task 6 rollout-review corrections (Opus 5 F1, GLM-5.2 I1/C3): `DELETE /api/me` now disposes of **every** membership the caller holds, not just the newest — a re-homed transfer successor no longer leaves their original household behind with no members. Household membership rows are locked `FOR UPDATE` per household, so two last members deleting at once cannot both step out. Receipt lookup honours `expires_at` (expired reads the same as unknown) and spends an in-process per-client budget on **misses only** (20/hour), so a holder can poll freely and no unauthenticated request writes rows. Migration 0027 proven re-runnable as-is (runner applies file + ledger row in one transaction; `ADD COLUMN IF NOT EXISTS` + `DROP CONSTRAINT IF EXISTS`/`ADD`) — documented, not changed. Focused gate: typecheck + 21 accountDeletion + 83 accountDeletionTransfer.
- [x] Task 6 rollout-review corrections, round 2 (MiniMax): `POST /api/account-deletion/transfers` no longer picks the caller's most recently joined household. The source is the household whose membership says `role = 'owner'` — none is still 403, exactly one names the garden, two or more is refused with 409 `ambiguous_source_household` rather than guessed at, and resume-by-existing-row runs first so a started handoff never has to disambiguate. Side effect: an owner who later joined someone else's garden used to get 403 and now works. Migration 0029 adds a partial unique index on `source_household_id WHERE phase <> 'cancelled'` — 0025's index is unique per *owner*, so two co-owners could each hand over the same garden and each reach `source_deleted`; the loser now gets 409 `source_transfer_active`. Naming the household on the wire stays the eventual fix and needs an iOS client that sends one. Focused gate: typecheck + 21 accountDeletion + 87 accountDeletionTransfer, stable under `--rerun-each 2`.
- [x] Task 6 server deployed to Fly on 2026-07-26 with migrations 0024–0029, healthy worker, transfer/delete routes registered, and `GARDEN_TOOLS_ENABLED` absent (fail-closed). Fresh Production backup created; restored into disposable PostgreSQL 17; all six migrations applied; deletion suites 108/108. Docker runtime now carries PostgreSQL 17 client so scheduled backups match Production.
- [ ] Next: authenticated disposable-account `DELETE /api/me` smoke, then Production device gates after build-52 processing/installability.

## Blockers

- Apple CDN AASA gate passed. Remaining gates require TestFlight build 52 and physical devices with disposable Apple IDs.

## Open questions

- None.
