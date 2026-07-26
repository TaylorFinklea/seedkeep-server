# Current State

## Branch

`main`

## Plan

- [x] `seedkeep-27d.12` Task 1 server state machine: migrations 0025/0026 + authenticated transfer routes + typed final-delete disposition (`9fa6ac5`, review fixes `712bacf`). Sol adversarial re-review CLEAN. Full gate: 322 unit + 199 integration, typecheck clean. **DO NOT DEPLOY** until iOS Tasks 3–5 send `cloudkit_disposition`.
- [x] `seedkeep-27d.12` Task 4 hardening extended the server contract (`addcd5f`, enumeration fix `6e80dac`): atomic `source_deleting` lease, cancellation fence, non-consuming handoff inspection, token rotation, hashed deletion receipts and unauthenticated committed-delete lookup. Sol review CLEAN. Fresh gate: typecheck + 322 unit + 221 integration. **DO NOT DEPLOY** until Task 5 iOS UI ships the full contract.
- [x] Task 5 exact-household contract (`7ea703a`): authenticated `GET /api/households/:id`, membership non-enumeration, deterministic generic-household ordering. Matching iOS handoff UI is complete. Fresh gate: typecheck + 322 unit + 228 integration.
- [x] Task 6 rollout-review corrections (Opus 5 F1, GLM-5.2 I1/C3): `DELETE /api/me` now disposes of **every** membership the caller holds, not just the newest — a re-homed transfer successor no longer leaves their original household behind with no members. Household membership rows are locked `FOR UPDATE` per household, so two last members deleting at once cannot both step out. Receipt lookup honours `expires_at` (expired reads the same as unknown) and spends an in-process per-client budget on **misses only** (20/hour), so a holder can poll freely and no unauthenticated request writes rows. Migration 0027 proven re-runnable as-is (runner applies file + ledger row in one transaction; `ADD COLUMN IF NOT EXISTS` + `DROP CONSTRAINT IF EXISTS`/`ADD`) — documented, not changed. Focused gate: typecheck + 21 accountDeletion + 83 accountDeletionTransfer.
- [ ] Next: coordinated Task 6 deployment with matching iOS release; do not deploy server alone. The deploy still ships `GARDEN_TOOLS_ENABLED` default-off (the approved R1 Sprout/MCP cutover) — intended, and called out in the release plan.

## Blockers

- None.

## Open questions

- None.
