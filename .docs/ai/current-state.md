# Current State

## Branch

`main`

## Plan

- [ ] Website email-code auth bridge (2026-10-30): local implementation adds Better Auth email OTP + generic SMTP, exact browser-origin allowlist, HttpOnly cookie sessions for web, existing Bearer sessions for native, durable per-email/global OTP-send limits, bounded request parsing, and socket-peer-backed Better Auth IP limits. Server typecheck/build and focused tests pass (28/28). Synthetic Neon `production` E2E used a fake sender, rejected a wrong OTP, verified a valid cookie session and `/api/me`, exercised cookie refresh propagation and OTP throttling, then verified exact synthetic account/session/OTP/per-email-limit cleanup; the shared global throttle bucket expires naturally. It also confirmed `verification` timestamps are TIMESTAMPTZ and limiter parameters use Date values. That E2E preceded the final Origin-before-quota and `Cache-Control: no-store` middleware fixes; focused tests cover those final changes. Web client/session tests pass (15/15); isolated Svelte check/build pass. Full server unit suite: 319 passed, 13 skipped, 5 failed in DB-dependent suites because localhost:5432 refused connections. Production SMTP configuration/delivery and deployment remain unconfigured and unverified. Existing Neon migrations 0001–0029 were already applied/read back; local migration 0030 for worker state is pending and has not been applied. Independent reviews found no additional material blockers. Review note: Better Auth's conservative 3/min peer limit may be shared when a reverse proxy presents one socket peer for many clients; forwarded IP headers are deliberately not trusted.
- [x] `seedkeep-27d.12` Task 1 server state machine: migrations 0025/0026 + authenticated transfer routes + typed final-delete disposition (`9fa6ac5`, review fixes `712bacf`). Sol adversarial re-review CLEAN. Full gate: 322 unit + 199 integration, typecheck clean. **DO NOT DEPLOY** until iOS Tasks 3–5 send `cloudkit_disposition`.
- [x] `seedkeep-27d.12` Task 4 hardening extended the server contract (`addcd5f`, enumeration fix `6e80dac`): atomic `source_deleting` lease, cancellation fence, non-consuming handoff inspection, token rotation, hashed deletion receipts and unauthenticated committed-delete lookup. Sol review CLEAN. Fresh gate: typecheck + 322 unit + 221 integration. **DO NOT DEPLOY** until Task 5 iOS UI ships the full contract.
- [x] Task 5 exact-household contract (`7ea703a`): authenticated `GET /api/households/:id`, membership non-enumeration, deterministic generic-household ordering. Matching iOS handoff UI is complete. Fresh gate: typecheck + 322 unit + 228 integration.
- [x] Task 6 rollout-review corrections (Opus 5 F1, GLM-5.2 I1/C3): `DELETE /api/me` now disposes of **every** membership the caller holds, not just the newest — a re-homed transfer successor no longer leaves their original household behind with no members. Household membership rows are locked `FOR UPDATE` per household, so two last members deleting at once cannot both step out. Receipt lookup honours `expires_at` (expired reads the same as unknown) and spends an in-process per-client budget on **misses only** (20/hour), so a holder can poll freely and no unauthenticated request writes rows. Migration 0027 proven re-runnable as-is (runner applies file + ledger row in one transaction; `ADD COLUMN IF NOT EXISTS` + `DROP CONSTRAINT IF EXISTS`/`ADD`) — documented, not changed. Focused gate: typecheck + 21 accountDeletion + 83 accountDeletionTransfer.
- [x] Task 6 rollout-review corrections, round 2 (MiniMax): `POST /api/account-deletion/transfers` no longer picks the caller's most recently joined household. The source is the household whose membership says `role = 'owner'` — none is still 403, exactly one names the garden, two or more is refused with 409 `ambiguous_source_household` rather than guessed at, and resume-by-existing-row runs first so a started handoff never has to disambiguate. Side effect: an owner who later joined someone else's garden used to get 403 and now works. Migration 0029 adds a partial unique index on `source_household_id WHERE phase <> 'cancelled'` — 0025's index is unique per *owner*, so two co-owners could each hand over the same garden and each reach `source_deleted`; the loser now gets 409 `source_transfer_active`. Naming the household on the wire stays the eventual fix and needs an iOS client that sends one. Focused gate: typecheck + 21 accountDeletion + 87 accountDeletionTransfer, stable under `--rerun-each 2`.
- [x] Task 6 server deployed to Fly on 2026-07-26 with migrations 0024–0029, healthy worker, transfer/delete routes registered, and `GARDEN_TOOLS_ENABLED` absent (fail-closed). Fresh Production backup created; restored into disposable PostgreSQL 17; all six migrations applied; deletion suites 108/108. Docker runtime now carries PostgreSQL 17 client so scheduled backups match Production.
- [x] Re-sign-in regression fixed and deployed (`6742676`): custom account deletion now returns Better Auth's cookie-expiration headers after deleting the DB session. Full deploy gate 322 unit + 238 integration, typecheck clean; Production health green. Build-52 solo-owner Gate 2 then proved immediate Apple sign-in succeeds without reinstalling and deleted data does not return.

## Production-prep (2026-10-31, local only)

`fly.web.toml` targets a separate `seedkeep-web-api` app, sets production
cookie/origin configuration for `api.seedkeep.finklea.dev` and
`seedkeep.finklea.dev`, and has no release migration command. Migration 0030
moves `_seedkeep_kv` creation out of runtime worker paths; it is still pending
on Neon. `scripts/provision-runtime-role.sql` is a separate operator step for
a non-owner runtime role after migrations; it is not executed. Health readiness
now returns 503 if that table is absent or unreadable. The backup child receives
libpq connection fields via environment, not the URL in argv, and its URL is
removed from the child environment.

The Dockerfile keeps Bun 1.3 and uses Alpine 3.24's PostgreSQL 18 client for
the selected Neon server, rather than copying `pg_dump` and linked libraries
from the full official PostgreSQL server image or changing Bun. An allowlisted
local image build passed: Bun 1.3.14 and `pg_dump` 18.6 ran, and the server
started and shut down with synthetic environment values. In a separate,
localhost-only synthetic PostgreSQL 18 container, migrations 0001–0030 and the
operator role grants succeeded; `seedkeep_web_runtime` produced a full dump
that restored into an empty database with matching 44-table and 30-ledger-row
counts. This did not contact Neon or validate a Neon/S3 backup. The temporary
container, anonymous volume, image tag, env files, and build context were
removed. DNS and
certificate setup, production database role/migration, proxy-peer validation,
Fly app availability, deployment, and production runtime checks remain pending.
Do not use `scripts/deploy.sh`; it targets legacy `fly.toml` and applies
migrations.

Read-only Neon preflight confirmed `neondb_owner` is not a superuser and has
`CREATEROLE`; no production role or schema change was made. The attempt to read
the Neon connection string solely to extract query-parameter names was blocked
by local approval review because that CLI response contains the owner
credential. It was not retried, so the selected URL's parameter names and
compatibility with the backup allowlist remain unverified. Before using the
Docker build configuration with repository contents, review its directory
allowlists for nested sensitive files; the synthetic image build used a
separate explicit temporary context.

## Blockers

- Participant and solo-owner Production gates passed. Two-account transfer gate remains blocked on two distinct disposable Apple identities; do not use a family member's real account as a destructive test subject.

## Open questions

- None.
