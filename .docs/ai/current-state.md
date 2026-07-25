# Current State

## Branch

`main`

## Plan

- [x] `seedkeep-27d.12` Task 1 server state machine: migrations 0025/0026 + authenticated transfer routes + typed final-delete disposition (`9fa6ac5`, review fixes `712bacf`). Sol adversarial re-review CLEAN. Full gate: 322 unit + 199 integration, typecheck clean. **DO NOT DEPLOY** until iOS Tasks 3–5 send `cloudkit_disposition`.
- [x] `seedkeep-27d.12` Task 4 hardening extended the server contract (`addcd5f`, enumeration fix `6e80dac`): atomic `source_deleting` lease, cancellation fence, non-consuming handoff inspection, token rotation, hashed deletion receipts and unauthenticated committed-delete lookup. Sol review CLEAN. Fresh gate: typecheck + 322 unit + 221 integration. **DO NOT DEPLOY** until Task 5 iOS UI ships the full contract.
- [ ] Next: Task 5 iOS successor handoff and truthful UI.

## Blockers

- None.

## Open questions

- None.
