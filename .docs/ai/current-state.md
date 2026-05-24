# Current State

> Updated at the end of every work session. Read this first.

## Active Branch

`main`

## Last Session Summary

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
