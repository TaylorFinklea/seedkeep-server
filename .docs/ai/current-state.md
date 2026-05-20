# Current State

> Updated at the end of every work session. Read this first.

## Active Branch

`main`

## Last Session Summary

**Date**: 2026-05-20 — Phase A: smart planting window (server)

- Built the **Phase A server side of the smart-planting-window feature** (iOS 0.2.0). Plan: `.docs/ai/plans/2026-05-20-smart-planting-window-server.md`. Design spec: `~/git/seedkeep/.docs/ai/specs/2026-05-20-smart-planting-window-design.md`. Executed as 10 tasks via subagent-driven development on branch `smart-planting-window`, merged to `main` (commit `6863d34`).
- **Migration 0007** — `zip_locations` reference table + 6 household location columns (`home_zip`, `latitude`, `longitude`, `usda_zone`, `avg_last_frost`, `avg_first_frost`).
- **Migration 0008** — `recommendation_cache` + `recommendation_jobs` tables + two Postgres invalidation triggers (catalog horticultural change, household location change).
- **ZIP dataset** — `data/zip_locations.csv` (33,751 rows: real USDA zones + Census ZCTA centroids; frost dates are zone-estimated — see Blockers). Built by `scripts/build-zip-dataset.ts`, loaded by `scripts/seed-zip-locations.ts` (`bun run seed:zip`).
- **Routes** — `PUT /api/households/me/location` (ZIP → resolves zone/lat-lon/frost), `GET /api/recommendations/:catalogSeedId` (single, synchronous AI fallback), `POST /api/recommendations/bulk` (batch, enqueues async AI jobs, returns `verdict:unknown` stubs for low-confidence misses).
- **Engine** — `src/lib/recommendation/`: pure `engine.ts` (rule baseline), `projection.ts` (window→verdict+60-day scores), `aiFallback.ts` (Anthropic call for low confidence), `locationSignature.ts` (cache key).
- **Worker** — `src/worker.ts`, a separate Fly process (`fly.toml` `[processes]` now has `app` + `worker`) draining `recommendation_jobs`.
- Verified: `bun run typecheck` clean, **39/39 unit tests pass**, `scripts/recommendations-smoke.ts` **9/9 end-to-end checks pass** against a local server.

**Earlier (2026-05-04, F1–F5 architecture pivot)**: Bun+Hono+Postgres+S3 bootstrap, tier system + IAP receipt validation. The prior Workers attempt is preserved at `~/git/seedkeep` tag `phase-1-workers-attempt`. (Phase 2A/B/C garden-bed work shipped on iOS; server schema for beds/planting-events landed in migrations 0005/0006.)

## Build Status

- 8 migrations apply cleanly (`0001`–`0008`). `bun run migrate` idempotent.
- `bun run test` → **39/39 unit tests pass** (randomPick, confidence, projection, engine, aiFallback, locationSignature, worker).
- `bun run typecheck` clean. `bun run dev` boots. `docker compose up db` brings up Postgres.
- New scripts: `build:zip-dataset`, `seed:zip`. New smoke script: `scripts/recommendations-smoke.ts`.

## Blockers

- **`main` is not pushed to origin** — Phase A is merged locally only. `git -C ~/git/seedkeep-server push origin main` when ready (the branch was merged fast-forward; ~21 commits ahead of `origin/main`).
- **Not yet deployed** — the `recommendation` routes + the new `worker` process are on local `main` only. Fly deploy needed; the `worker` process must be provisioned on Fly (the `[processes]` block adds it, but Fly needs the deploy + likely a machine for it).
- **`zip_locations` frost dates are zone-estimated**, not real per-ZIP NOAA data — accuracy ~±1–2 weeks. Real NOAA freeze/frost climatology is a clean future upgrade (no schema change). USDA zones + lat/lon ARE real.
- `ANTHROPIC_API_KEY` unset on Fly — the recommendation AI fallback and the worker degrade gracefully (rule baseline stands; jobs fail after 3 attempts, verdict stays `unknown`). `/api/extractions` still 503s for hosted tier. `APPLE_IAP_SHARED_SECRET` also unset — both gated behind the iOS feature flag.

## Hono port-time gotcha (F1e learning)

`subrouter.use('*', ...)` bleeds across sibling subrouters mounted at the same prefix. We compose middleware per-route now (`route(path, ...auth, handler)`) instead of at the subrouter level. The Workers attempt didn't trip on this only because its smoke ordering masked the issue.

## Next concrete step

1. **Deploy Phase A** — push `main` to origin, `fly deploy`, run migrations 0007 + 0008 against the Fly Postgres, run `seed:zip` to load `zip_locations` there, and provision the `worker` process on Fly. Then smoke `PUT /households/me/location` + `GET /recommendations/:id` against `seedkeep-server.fly.dev`.
2. **Plan 2 — iOS** — write the Phase B implementation plan (`seedkeep-ios`: SeedkeepKit DTOs, ZIP-entry Settings screen, `WeatherKitRefiner`, `RecommendationStore`, `RecommendationPanel`, the four UI surfaces). The design spec's "Phase B" section is the input. Write it against the deployed API.

Older follow-ups: Hosted-tier unflag (register `app.seedkeep.ios.hosted.{monthly,yearly}` in App Store Connect, set `APPLE_IAP_SHARED_SECRET` + `ANTHROPIC_API_KEY` via `fly secrets set`, flip `isHostedTierEnabled`). Backlog: catalog moderation admin UI, S2S receipt-revalidation cron, real NOAA frost data for `zip_locations`.
