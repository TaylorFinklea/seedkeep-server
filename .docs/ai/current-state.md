# Current State

## Branch

`main`

## Website trial retired — November 5

The owner restored native iOS/iPadOS/macOS-only direction and approved exact
website-only removal. Fly `seedkeep-web-api`, Neon project `falling-sea-61884978`
(database/photos/backups), Pages `seedkeep-web` and the three app DNS records
are deleted; provider readbacks confirm absence. The trial monitor is removed.
Legacy Fly apps, stopped machine configs, IPs and the attached 1-GB database
volume are preserved. Native iCloud data, Git, mail and Resend were excluded.

DNS apply `42070938051` succeeded once through the reviewed workflow; its apply
flag is false. Post-plan `42071257237` has 41 no-ops. Independent Sol outcome
review passed; DNS source passed 69 safety tests, CI and Sol/DeepSeek reviews.
Application source was not deployed or pushed. Earlier results below are
historical. Receipts: umbrella `phases/2026-11-05-return-to-native.md`
(`seedkeep-xz4`). Native guard/release work remains open.

## Journal and fresh catalog — deployed 2026-11-04

Server `4d5fb8f` is deployed as Fly release 6 to the existing two trial
machines. Image digest:
`sha256:a1faaed6f824ed2a680fa8c3122bfeca3403085ef501bf382ee87a3edf1a3676`.
Authenticated bounded catalog search, confirmed owner publication, origin-owner
correction review, durable audit/quota/replay, and journal parent validation /
retry-safe creation are implemented without a migration. No-key recommendation
requests no longer enqueue impossible paid jobs. Publication audit rows survive
the routine sweep. No legacy catalog import or paid AI keys were enabled.

Five focused real PostgreSQL 18 integration tests passed, including concurrent
quota/replay and stale/foreign/deleted-parent cases. The 139 relevant catalog /
recommendation unit tests, typecheck and build passed. Independent read-only
Sol and direct text-only DeepSeek V4.1 Flash reviews completed. Full browser
flows used real local Hono/PostgreSQL with synthetic S3; production verification
is read-only. The disposable QA stack was removed. Contract/results: umbrella
`phases/2026-11-04-journal-fresh-catalog.md`; tracking `seedkeep-server-im1` /
`seedkeep-0nz.2`. The trial monitor stays active.

## Earlier inventory production QA — 2026-11-04

Inventory QA ran on `8283d84` (manual seed type `8430c77`, household location
readback `235a793`, PATCH-default preservation `8283d84`), deployed as Fly
release 5 to the same two trial machines. Image digest:
`sha256:b49a1f91fb3b7f4763d3fc2e51340d4071c8a857ea90baca5741c45171fcb294`.
Migration `0031_seed_custom_type.sql` and its canonical ledger row were applied
and read back on the selected Neon production branch. Existing reference-data
scripts populated 33,751 ZIP rows, 53 regions, 30 aliases and 38 calendar
entries. ZIP 66109 resolves Zone 6b; no user inventory was replaced.

Each of the three server slices passed focused PostgreSQL 18 tests (2/2),
`bun run typecheck`, `bun run build`, read-only Sol and direct text-only
DeepSeek V4.1 Flash reviews. The final PATCH check covers preserved packet
count/source, explicit updates and unchanged POST defaults. These are focused
checks, not a new full-suite result. Disposable test containers were removed.

Authenticated production browser checks passed manual seed edits, tags,
locations, private photos including reload, search, CSV export, beds, planting
edits and Today task completion. Packet count 7 survived an unrelated status
edit and full reload. Owner-approved synthetic fixtures were removed through
normal UI/API routes; the exact Finklea garden and ZIP 66109 remained intact.
Final scoped counts were zero for QA seeds/beds/locations/tags and household
photos/active plantings. API health, worker heartbeat and backup freshness pass.
See umbrella `phases/2026-11-04-website-e2e.md` for scope and limitations. The
trial monitor remains active; no additional resources or source pushes occurred.

## Plan

- [ ] Website email-code auth bridge (2026-10-30): local implementation adds Better Auth email OTP + generic SMTP, exact browser-origin allowlist, HttpOnly cookie sessions for web, existing Bearer sessions for native, durable per-email/global OTP-send limits, bounded request parsing, and socket-peer-backed Better Auth IP limits. Server typecheck/build and focused tests pass (28/28). Synthetic Neon `production` E2E used a fake sender, rejected a wrong OTP, verified a valid cookie session and `/api/me`, exercised cookie refresh propagation and OTP throttling, then verified exact synthetic account/session/OTP/per-email-limit cleanup; the shared global throttle bucket expires naturally. It also confirmed `verification` timestamps are TIMESTAMPTZ and limiter parameters use Date values. That E2E preceded the final Origin-before-quota and `Cache-Control: no-store` middleware fixes; focused tests cover those final changes. Web client/session tests pass (15/15); isolated Svelte check/build pass. Full server unit suite: 319 passed, 13 skipped, 5 failed in DB-dependent suites because localhost:5432 refused connections. Neon `production` migrations 0001–0029 were previously applied/read back; the extensionless `0030` ledger entry and migration were corrected in a Sol-reviewed guarded transaction on 2026-11-04. The reviewed `seedkeep_web_runtime` role was provisioned on that branch; login and ACL checks passed. Its generated password is stored in Keychain service `com.seedkeep.neon.production`, account `seedkeep_web_runtime`. Reviewed helper staged the Fly runtime secrets through stdin. The live email-code path now authenticates and reaches the garden onboarding page. The household list and explicit selection repair passed focused PostgreSQL 18 integration tests (5/5), server typecheck and build, Sol review, and direct DeepSeek review. The conservative socket-peer rate limiter remains in place; forwarded-IP trust remains unchanged. Review note: Better Auth's conservative 3/min peer limit may be shared when a reverse proxy presents one socket peer for many clients; forwarded IP headers are deliberately not trusted.
- [x] `seedkeep-27d.12` Task 1 server state machine: migrations 0025/0026 + authenticated transfer routes + typed final-delete disposition (`9fa6ac5`, review fixes `712bacf`). Sol adversarial re-review CLEAN. Full gate: 322 unit + 199 integration, typecheck clean. **DO NOT DEPLOY** until iOS Tasks 3–5 send `cloudkit_disposition`.
- [x] `seedkeep-27d.12` Task 4 hardening extended the server contract (`addcd5f`, enumeration fix `6e80dac`): atomic `source_deleting` lease, cancellation fence, non-consuming handoff inspection, token rotation, hashed deletion receipts and unauthenticated committed-delete lookup. Sol review CLEAN. Fresh gate: typecheck + 322 unit + 221 integration. **DO NOT DEPLOY** until Task 5 iOS UI ships the full contract.
- [x] Task 5 exact-household contract (`7ea703a`): authenticated `GET /api/households/:id`, membership non-enumeration, deterministic generic-household ordering. Matching iOS handoff UI is complete. Fresh gate: typecheck + 322 unit + 228 integration.
- [x] Task 6 rollout-review corrections (Opus 5 F1, GLM-5.2 I1/C3): `DELETE /api/me` now disposes of **every** membership the caller holds, not just the newest — a re-homed transfer successor no longer leaves their original household behind with no members. Household membership rows are locked `FOR UPDATE` per household, so two last members deleting at once cannot both step out. Receipt lookup honours `expires_at` (expired reads the same as unknown) and spends an in-process per-client budget on **misses only** (20/hour), so a holder can poll freely and no unauthenticated request writes rows. Migration 0027 proven re-runnable as-is (runner applies file + ledger row in one transaction; `ADD COLUMN IF NOT EXISTS` + `DROP CONSTRAINT IF EXISTS`/`ADD`) — documented, not changed. Focused gate: typecheck + 21 accountDeletion + 83 accountDeletionTransfer.
- [x] Task 6 rollout-review corrections, round 2 (MiniMax): `POST /api/account-deletion/transfers` no longer picks the caller's most recently joined household. The source is the household whose membership says `role = 'owner'` — none is still 403, exactly one names the garden, two or more is refused with 409 `ambiguous_source_household` rather than guessed at, and resume-by-existing-row runs first so a started handoff never has to disambiguate. Side effect: an owner who later joined someone else's garden used to get 403 and now works. Migration 0029 adds a partial unique index on `source_household_id WHERE phase <> 'cancelled'` — 0025's index is unique per *owner*, so two co-owners could each hand over the same garden and each reach `source_deleted`; the loser now gets 409 `source_transfer_active`. Naming the household on the wire stays the eventual fix and needs an iOS client that sends one. Focused gate: typecheck + 21 accountDeletion + 87 accountDeletionTransfer, stable under `--rerun-each 2`.
- [x] Task 6 server deployed to Fly on 2026-07-26 with migrations 0024–0029, healthy worker, transfer/delete routes registered, and `GARDEN_TOOLS_ENABLED` absent (fail-closed). Fresh Production backup created; restored into disposable PostgreSQL 17; all six migrations applied; deletion suites 108/108. Docker runtime now carries PostgreSQL 17 client so scheduled backups match Production.
- [x] Re-sign-in regression fixed and deployed (`6742676`): custom account deletion now returns Better Auth's cookie-expiration headers after deleting the DB session. Full deploy gate 322 unit + 238 integration, typecheck clean; Production health green. Build-52 solo-owner Gate 2 then proved immediate Apple sign-in succeeds without reinstalling and deleted data does not return.

## Website trial deployment (2026-11-04)

`fly.web.toml` targets the separate `seedkeep-web-api` app, sets production
cookie/origin configuration for `api.seedkeep.finklea.dev` and
`seedkeep.finklea.dev`, and has no release migration command. The authenticated
household-list repair added `GET /api/households` scoped to active memberships
and made `X-Household-Id` select only a live membership, with a non-enumerating
403 for empty, foreign, or deleted ids. Requests without the header retain the
newest-membership default. The initial repair ran as release 2; current
release 6 and its source/digest are recorded above.
API machine `185770e2cd02e8` and worker `8654d92a0261e8` run in `iad`, each
shared 1 CPU / 256 MB. The app has no volumes and only shared IPv4
`66.241.125.112`; both selected custom domains have working HTTPS. Worker
health and a successful backup were verified on 2026-11-04. The owner
completed the production email-code sign-in; the authenticated browser reached
`/onboarding` and rendered “Set up your garden” with no console errors or
warnings.

Migration 0030
moves `_seedkeep_kv` creation out of runtime worker paths; it and its ledger
entry were applied and read back on the selected Neon `production` branch on
2026-11-03. The hosted ledger originally recorded the migration as
`0030_worker_state_kv`; a Sol-reviewed guarded transaction corrected its key
to the canonical filename `0030_worker_state_kv.sql` on 2026-11-04.
The reviewed `scripts/provision-runtime-role.sql` grant set was
applied to create `seedkeep_web_runtime`; login succeeded through Neon CLI.
The role is non-superuser, cannot create databases/roles or bypass RLS, has no
public-schema CREATE privilege, and has SELECT-only access to the migration
ledger. ACL spot checks confirmed DML on `_seedkeep_kv`. Its generated password
is held in Keychain service `com.seedkeep.neon.production`, account
`seedkeep_web_runtime`; the reviewed helper staged the runtime secrets to Fly
via stdin. Health readiness
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
removed. Production SMTP accepted the email-code request and authenticated
onboarding was verified in the real browser. DNS and TLS are working for both
custom domains. Runtime API/worker deployment, health and backup checks passed.
The household-list and explicit selection fix passed five synthetic PostgreSQL
18 integration tests, typecheck and build, and Sol and direct DeepSeek review.
The conservative socket-peer limiter remains; no forwarded-IP headers are
trusted. Migration 0030 and the runtime role are no longer pending on Neon.
Do not use `scripts/deploy.sh`; it targets legacy `fly.toml` and applies
migrations.

Read-only Neon preflight confirmed `neondb_owner` is not a superuser and has
`CREATEROLE`; the later approved migration and restricted runtime-role
provisioning are recorded above. The attempt to read
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
