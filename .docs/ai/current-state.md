# Current State

> Updated at the end of every work session. Read this first.

## Active Branch

`main`

## Last Session Summary

**Date**: 2026-05-25 (afternoon) — Phase 4 (Sprout) server foundation deployed (Fly v17)

- Inline-executed the 11-task plan at `.docs/ai/plans/2026-05-25-phase-4-sprout-server.md` on worktree branch `phase-4-sprout-server`. Single persistent agent (no subagent dispatch) — applied the lesson from Phase 3.
- **Migration 0012** — 4 new tables (`assistant_keys`, `assistant_threads`, `assistant_messages`, `assistant_tool_calls`) + indexes + status CHECK + partial proposed-index.
- **AES-256-GCM BYOK encryption** (`src/lib/assistant/keyEncryption.ts`) — node:crypto, no new deps. Master key in `ASSISTANT_KEY_MASTER` Fly secret. Per-row IV + auth tag; tamper-detected on decrypt. 8 unit tests.
- **Tool registry** (`src/lib/assistant/tools.ts`) — 24 tools with zod schemas + `requires_confirmation` flags. Uses zod 4's `z.toJSONSchema()` for the Anthropic input_schema. 17 unit tests.
- **Tool executor** (`src/lib/assistant/executor.ts`) — direct SQL handlers for all 24 tools. Confirm-required tools compute Was→Becomes diffs via `applyPatch`; deferred apply via `executeProposedChange`. 8 unit tests on the pure parts; DB-touching paths covered by smoke.
- **Anthropic streaming client** (`src/lib/assistant/anthropicStream.ts`) — raw fetch to `api.anthropic.com/v1/messages` with `stream:true`; ReadableStream-based SSE parser; mockable via `MOCK_ANTHROPIC_URL` env. 9 SSE parser tests (including chunk-boundary splits, comment heartbeats, malformed-JSON resilience).
- **Sprout persona** (`src/lib/assistant/prompt.ts`) — system-prompt builder with household snapshot + page context. 9 unit tests.
- **5 new routes** (`src/routes/assistant.ts` + extension to `src/routes/households.ts`): thread CRUD, streaming endpoint with tool orchestration loop + proposed-change pause, `/confirm` + `/cancel`, key PUT/DELETE/GET. Hono `streamSSE` helper for the SSE writes.
- **Orchestration loop**: anthropic call → tool dispatch → DB write → re-call until natural stop OR proposed-change pause. Hard cap MAX_TURNS=10. Placeholder assistant_message row inserted at message_start to satisfy the tool_calls FK during streaming.
- **Smoke** (`scripts/assistant-smoke.ts`) — 18/18 checks. Spawns a mock Anthropic SSE server on port 14040 that returns canned events keyed by `MOCK:<scenario>` markers; exercises text-only, tool_use auto-execute, invalid args, unknown tool, proposed_change pause, awaiting-confirmation 409 gate, confirm + cancel paths with DB verification.
- Total tests: 117/117 unit (was 66) + 18/18 smoke. Plus regression: journal + recommendations smokes still 11/11 each.
- **`ASSISTANT_KEY_MASTER` set on Fly** (32-byte random base64, generated via `openssl rand -base64 32`). Migration applied via `release_command`. `/api/assistant/threads` + `/api/households/me/assistant_key` return 401 unauthed (deployed + auth-gated).

**Date**: 2026-05-25 — Phase 3 (Journal) server foundation deployed (Fly v15)

- Subagent-driven implementation of the 10-task plan at `.docs/ai/plans/2026-05-24-phase-3-journal-server.md`. All 9 build commits executed on worktree branch `phase-3-journal-server` (one task per commit, two-stage review per task), fast-forward merged to main, pushed to origin, deployed.
- **Migration 0011** — `journal_entries`, `journal_entry_photos`, `journal_checklist_items` tables + 7 indexes + at-most-one polymorphic CHECK + data migration converting legacy `planting_events.kind='note'` rows into journal_entries + soft-delete of the legacy rows + drop of `'note'` from the planting_events kind CHECK. Per the migration-backfill-required rule, the schema add + data backfill ride in the same transaction. `idx_journal_entries_household_occurred` is partial (`WHERE deleted_at IS NULL`) to match the project-wide active-list idiom; `idx_journal_entries_household_updated` is non-partial because delta-sync needs tombstones.
- **Pure libs** (`src/lib/journal/`): `retrospectiveMmDdWindow` (MM-DD ±3 fuzz with year-boundary wrap, uses 2023 reference year to avoid Feb 29) + `validateAtMostOneAttach` (pre-SQL-CHECK validation for cleaner 400s). 11 new unit tests; total **66/66** (was 55).
- **Routes** — 10 new routes under `/api/journal/*`: GET feed (delta-sync envelope via `parseDeltaQuery`/`buildDeltaPayload`), POST/PATCH/DELETE entry, POST/DELETE photo, POST/PATCH/DELETE checklist item, GET `/:id/photos`, GET `/:id/checklist`, GET `/photos/:photoId` (binary fetch), GET `/retrospective?on=MM-DD` (year-grouped, **excludes the current year + future**). Reuses the existing `seed_photos` direct-bytes upload pattern + the `newPhotoKey`/`putPhoto`/`getPhoto`/`deletePhoto` storage helpers (extended scope+role unions to admit `'journal'` + `'photo'`).
- **Smoke + verify** — `scripts/journal-smoke.ts` (11/11 checks) + `scripts/lib/verify-migration-0011.sql` for the data-migration check. Recommendations smoke (regression gate) still 11/11.
- **Deployed to Fly as release v15**. Migration applied via `release_command`. Prod verify: all 3 journal tables present; legacy/preserved/unsoftdeleted counts = 0/0/0 (no pre-existing kind='note' rows on prod, expected); `/api/health` 200.
- **Pattern improvement noted during T4/T7**: my plan prescribed multipart upload + a unified `/api/sync` envelope, but the codebase uses direct-bytes upload + per-entity sync-friendly listings. Plan was wrong; implementation followed the codebase. Worth recording so future plans don't repeat the same wrong assumption.

**Date**: 2026-05-24 (early AM) — `region_id` backfill + self-heal in `loadLocation` + Fly v14

- After Fly v13 shipped the cache-key fix, Taylor's pepper still returned rule-engine dates. Diagnosed by direct DB query (read-only): cache row showed `sig: "6b:39.0,-95.0:none"` — the `:none` suffix from the new signature code WAS active, but `regionId` came in NULL at signature time. Traced upstream: `households.region_id` was NULL on his row because migration 0009 added the column but never backfilled existing households, and `PUT /api/households/me/location` only resolves region on ZIP *change*, never on read.
- **One-shot prod backfill** via `fly ssh`: `UPDATE households SET region_id = zipToRegion(home_zip) WHERE region_id IS NULL` — 1 household updated (Taylor, `66109 → KS`). UPDATE fired the household-change trigger, wiping all his stale cache rows. Net cache rows: 0.
- **Self-healing patch** in `src/routes/recommendations.ts` `loadLocation()`: if `region_id IS NULL` and `home_zip IS NOT NULL`, derive via `zipToRegion()` and persist with a conditional UPDATE (`… WHERE region_id IS NULL` so it's idempotent). The persist fires the household-change trigger which invalidates the household's stale cache rows; the very next `readCache()` misses → fresh compute → extension lookup wins. Lazy migration: self-heals any future user in the same gap on their first recommendation request, no scheduled backfill needed.
- Commit `899fe64`. **Deployed as Fly v14**. Tests still 55/55, typecheck clean.
- **Pattern lesson**: Migration 0009 added three columns (`households.region_id`, `recommendation_cache.region_id`, `recommendation_cache.source CHECK`) and backfilled zero of them. Each gap surfaced as a separate symptom over the same session — stale rule rows surviving the trigger (fixed by 0010 + signature change), region_id null on cache writes (downstream of next), region_id null on the household (fixed here). Future schema migrations that add a column AND require its value for downstream behavior must either backfill or add a NOT NULL constraint that forces backfill — neither was done in 0009.

**Date**: 2026-05-23 (evening) — Cache invalidation bug fix + Fly v13

- User tested 66109 + a pepper seed and saw no change after KS deploy. Root cause: pre-extension cached rule-engine rows masked the new extension lookup. Two layered defects:
  1. `location_signature` was `zone:lat,lon` with no region segment, so adding extension data didn't change the cache key → primary-key lookup still returned the old row.
  2. The calendar-change trigger used `DELETE … WHERE region_id IN (OLD, NEW)` — SQL three-valued logic means `IN (NULL, 'KS')` doesn't match `region_id IS NULL` rows, so legacy rule rows (region_id null since migration 0009 didn't backfill) silently survived.
- **One-shot prod cleanup**: ran `DELETE FROM recommendation_cache WHERE region_id IS NULL` via `fly ssh console` — 2 stale rows wiped (Taylor's pepper + one other, both at signature `6b:39.0,-95.0`).
- **`locationSignature` now takes `regionId`** and emits `zone:lat,lon:regionId` (`:none` when null). Two new unit tests assert the region-different invariant. Total tests: **55/55** (was 53).
- **Migration 0010** makes the calendar trigger NULL-safe (`region_id IS NULL OR = OLD OR = NEW`) and re-runs the prod DELETE as a defensive idempotent step (matters for staging + future self-hosts).
- Commit `9e5c20a` on `seedkeep-server` main. **Deployed as Fly release v13**; migration applied via `release_command`. `/api/health` 200. Both `app` and `worker` machines refreshed.
- Belt + suspenders: signature includes region (cache miss when extension comes online) + trigger handles NULL (active invalidation when calendar rows change). Either one alone would catch the bug; both together are robust.

**Date**: 2026-05-23 — Extension Calendars: Kansas added (38 entries, 3 states); Fly v12

- User reported they're in ZIP 66109 (eastern KS, zone 6a) and wanted to actually test extension calendars against their own garden — VA + CA bundled coverage didn't help them.
- **Sourced from K-State Research and Extension MF315** (*Vegetable Garden Planting Guide*, revised February 2023, Upham + McMahon) — the canonical state-extension publication. Read the PDF via the Read tool's PDF support.
- **Added 12 KS calendar entries** (`data/extension_calendars.csv`, commit `f0a9a25`): tomato, pepper, lettuce, carrot, snap bean, cucumber, pea, spinach, radish, kale, beet, zucchini. Sourced from MF315's page-2 calendar (primary windows only — "most of Kansas" recommendation, the right conservative call for a state-level v1 entry). Indoor ranges for tomato + pepper derived from MF315's own "4–8 weeks indoors" rule (pages 3-4) applied to the outdoor primary start.
- **Basil excluded** — MF315 is vegetable-only, no herb coverage. Basil seeds in KS fall through to the rule-engine baseline. Future revision could source basil from a separate KSU herb publication or a community submission.
- Verified locally: `bun run seed:calendars` upserted **38 entries** (was 26), `zipToRegion('66109') → KS` returns the expected tomato window (May 1 – Jun 15 outdoor, Mar 5 – Apr 5 indoor). `bun run typecheck` clean, **53/53 unit tests pass**.
- **Deployed to Fly as release v12** (user ran the deploy + re-seed themselves). `/api/health` 200. KS rows live on prod.
- **Coverage now**: VA (13) + CA (13) + KS (12) = **38 calendar entries across 3 states**. Total dataset: 53 regions + 30 crop_aliases + 38 calendar entries.
- Companion iOS work — see `seedkeep-ios/.docs/ai/current-state.md` for build 18 (DatePicker out-of-window warning on the Plan event screen).

**Date**: 2026-05-22 — Extension Calendars v1 (foundation + Authority) implemented + merged to main

- Brainstormed → design spec → 10-task plan → subagent-driven execution. Spec: `~/git/seedkeep/.docs/ai/specs/2026-05-21-extension-calendars-design.md`. Plan: `.docs/ai/plans/2026-05-21-extension-calendars-server.md`.
- **Migration 0009** — `regions`, `extension_calendar_entries`, `crop_aliases` tables; `region_id` columns on `households` + `recommendation_cache`; `source` CHECK widened to admit `'extension'`; calendar-change invalidation trigger + extended household-change trigger.
- **Pure libs** (`src/lib/recommendation/`): `region.ts` (`zipToRegion` — ZIP3 → state, 50 states), `cropMatch.ts` (`normalizeCropKey`), `extensionBaseline.ts` (`resolveExtensionBaseline` — MM-DD → dated baseline, `confidence = 1.0`), `extensionLookup.ts` (DB lookup with alias resolution + sow_method precedence). 14 new unit tests.
- **Bundled dataset** — `data/regions.csv` (50 states), `data/crop_aliases.csv` (30 aliases), `data/extension_calendars.csv` (26 entries for VA + CA starter coverage). Loaded by new `scripts/seed-extension-calendars.ts` (`bun run seed:calendars`).
- **Engine integration** — `recommendations.ts` consults extension calendars *before* the rule engine in both `GET` and `POST /bulk`; on hit, caches with `source = 'extension'`, `confidence = 1.0`, region-scoped invalidation.
- **Household location** — `PUT /api/households/me/location` now resolves + stores `region_id` via `zipToRegion`.
- Verified: `bun run typecheck` clean, **53/53 unit tests pass**, `scripts/recommendations-smoke.ts` **11/11 checks pass** (added checks 10 + 11 for the extension hit and the calendar-change cache invalidation).
- Implemented as 10 commits in a worktree on branch `extension-calendars-server`, reviewed task-by-task (spec + code quality), merged fast-forward to `main` and pushed to origin.
- v1 schema is community-ready (`source`, `status`, `submitted_by`, review fields), but the community submission + AI-moderation pipeline, succession planting, regional crop discovery, and iOS Phase B (`sourceAttribution` DTO + `RecommendationPanel` credit line) are follow-on specs.
- **Polish** (`1b737d3`): widened `writeCache.source` type to admit `'extension'`; added `PR`, `GU`, `AP` regions to `regions.csv`.
- **Deployed to Fly** as release **v11**: `fly deploy --ha=false` applied migration 0009 via the `release_command`; `fly ssh console -C "bun run seed:calendars"` seeded **53 regions + 30 crop_aliases + 26 calendar entries** (VA + CA bundled coverage). Smoke: `/api/health` 200; all three recommendation routes return 401 unauthenticated (deployed + auth-gated).

**Date**: 2026-05-20 — Phase A: smart planting window (server)

- Built the **Phase A server side of the smart-planting-window feature** (iOS 0.2.0). Plan: `.docs/ai/plans/2026-05-20-smart-planting-window-server.md`. Design spec: `~/git/seedkeep/.docs/ai/specs/2026-05-20-smart-planting-window-design.md`. Executed as 10 tasks via subagent-driven development on branch `smart-planting-window`, merged to `main` (commit `6863d34`).
- **Migration 0007** — `zip_locations` reference table + 6 household location columns (`home_zip`, `latitude`, `longitude`, `usda_zone`, `avg_last_frost`, `avg_first_frost`).
- **Migration 0008** — `recommendation_cache` + `recommendation_jobs` tables + two Postgres invalidation triggers (catalog horticultural change, household location change).
- **ZIP dataset** — `data/zip_locations.csv` (33,751 rows: real USDA zones + Census ZCTA centroids; frost dates are zone-estimated — see Blockers). Built by `scripts/build-zip-dataset.ts`, loaded by `scripts/seed-zip-locations.ts` (`bun run seed:zip`).
- **Routes** — `PUT /api/households/me/location` (ZIP → resolves zone/lat-lon/frost), `GET /api/recommendations/:catalogSeedId` (single, synchronous AI fallback), `POST /api/recommendations/bulk` (batch, enqueues async AI jobs, returns `verdict:unknown` stubs for low-confidence misses).
- **Engine** — `src/lib/recommendation/`: pure `engine.ts` (rule baseline), `projection.ts` (window→verdict+60-day scores), `aiFallback.ts` (Anthropic call for low confidence), `locationSignature.ts` (cache key).
- **Worker** — `src/worker.ts`, a separate Fly process (`fly.toml` `[processes]` now has `app` + `worker`) draining `recommendation_jobs`.
- Verified: `bun run typecheck` clean, **39/39 unit tests pass**, `scripts/recommendations-smoke.ts` **9/9 end-to-end checks pass** against a local server.
- **Deploy-prepped** (commit `0cc328a`) — `Dockerfile` copies `data/` into the image (so `seed:zip` can run on Fly), and `fly.toml` runs `bun run migrate` as a `release_command` so migrations 0007/0008 apply automatically on deploy. `main` is pushed to origin.
- **Deployed to Fly** (2026-05-20) — `fly deploy --ha=false` shipped release **v9**; the `release_command` applied migrations 0007/0008 to the prod Postgres. `bun run seed:zip` loaded all 33,751 `zip_locations` rows. `worker` scaled to 0 (parked until `ANTHROPIC_API_KEY` is set). Smoke: `/api/health` → 200; the three recommendation routes return 401 unauthenticated (deployed + auth-gated correctly).

**Earlier (2026-05-04, F1–F5 architecture pivot)**: Bun+Hono+Postgres+S3 bootstrap, tier system + IAP receipt validation. The prior Workers attempt is preserved at `~/git/seedkeep` tag `phase-1-workers-attempt`. (Phase 2A/B/C garden-bed work shipped on iOS; server schema for beds/planting-events landed in migrations 0005/0006.)

## Build Status

- 9 migrations apply cleanly (`0001`–`0009`). `bun run migrate` idempotent.
- `bun run test` → **53/53 unit tests pass** (adds `region`, `cropMatch`, `extensionBaseline` to the existing `randomPick`, `confidence`, `projection`, `engine`, `aiFallback`, `locationSignature`, `worker`).
- `bun run typecheck` clean. `bun run dev` boots. `docker compose up db` brings up Postgres.
- Scripts: `build:zip-dataset`, `seed:zip`, `seed:calendars`. Smoke script `scripts/recommendations-smoke.ts` now runs **11/11** checks.

## Blockers

- **`zip_locations` frost dates are zone-estimated**, not real per-ZIP NOAA data — accuracy ~±1–2 weeks. Real NOAA freeze/frost climatology is a clean future upgrade (no schema change). USDA zones + lat/lon ARE real.
- `ANTHROPIC_API_KEY` is set on Fly and the `worker` process is scaled to 1 (release v10) — the recommendation AI fallback is **live**: low-confidence seeds get an AI-generated verdict instead of `verdict:unknown`. `APPLE_IAP_SHARED_SECRET` is still unset and `/api/extractions` still 503s — the Hosted tier stays feature-flagged off (deferred).

## Hono port-time gotcha (F1e learning)

`subrouter.use('*', ...)` bleeds across sibling subrouters mounted at the same prefix. We compose middleware per-route now (`route(path, ...auth, handler)`) instead of at the subrouter level. The Workers attempt didn't trip on this only because its smoke ordering masked the issue.

## Next concrete step

Smart planting window (0.2.0) and Extension Calendars v1 (foundation + Authority) are both **live on Fly** (releases v10 and v11). The recommendation engine consults extension calendars before the rule engine on every request. The remaining server-paired work is iOS Phase B for Extension Calendars.

1. **Phase B (iOS) for Extension Calendars** — own spec + plan. Tiny: add `sourceAttribution` to the `Recommendation` DTO in SeedkeepKit and a one-line "Per Virginia Cooperative Extension" credit in `RecommendationPanel` when `source == 'extension'`. Write against the now-live API.

Follow-on specs (each its own spec → plan → build cycle):
- **Community submission + AI-moderation pipeline** — the v1 schema is already community-ready; the submission flow is the immediate fast-follow.
- **Succession planting** — new repeated-planting model + engine + UI.
- **Regional crop discovery** — standalone "what grows here, when" browse view.

Non-blocking polish from the final review: collapse the duplicated extension cache-insert SQL by routing through `writeCache` (widen its `source` type to include `'extension'`); add PR/GU/AP entries to `regions.csv`; replace the naïve `split(',')` in `seed:calendars` with a proper CSV parser before community submissions land.

Older follow-ups: Hosted-tier unflag (register `app.seedkeep.ios.hosted.{monthly,yearly}` in App Store Connect, set `APPLE_IAP_SHARED_SECRET` via `fly secrets set`, flip `isHostedTierEnabled`). Backlog: catalog moderation admin UI, S2S receipt-revalidation cron, real NOAA frost data for `zip_locations`.
