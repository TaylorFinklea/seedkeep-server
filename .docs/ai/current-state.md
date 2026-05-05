# Current State

> Updated at the end of every work session. Read this first.

## Active Branch

`main`

## Last Session Summary

**Date**: 2026-05-04

- F1, F2, F3, F4, F5 of the F1–F5 architecture-pivot sequence all complete in one session.
- Server side (this repo): F1 (Bun + Hono + Postgres + S3 bootstrap, 11 routes, 13 unit tests) and F2 (tier column + subscriptions table + IAP receipt validation route + tier-branched extraction).
- iOS side (`~/git/seedkeep-ios`): F3 (Server URL picker, AI provider picker, OnDeviceExtractor over Vision OCR + FoundationModels) and F4 (BYOK keys in Keychain, BYOKExtractor for direct Anthropic / OpenAI vision calls, StoreKit 2 SubscriptionManager + receipt validation against this server).
- F5 verification: ran an end-to-end smoke against the live server with a seeded user. Verified — `/api/me`, `POST /api/households`, `/api/subscriptions/me` returns tier=free, `POST /api/subscriptions/verify` correctly returns 503 not_configured (no shared secret yet), `POST /api/extractions` returns 402 wrong_tier for free user, `POST /api/extractions/pre-extracted` succeeds + publishes a `catalog_seeds` row, tier promotion to `hosted` flips both gates correctly, post-promotion `/api/extractions` returns 503 not_configured (no Anthropic key yet — same shape as future success).
- The prior Workers attempt is preserved at `~/git/seedkeep` tagged `phase-1-workers-attempt`.

## Build Status

- All F1–F5 server-side work complete. Repo has: `package.json`, `tsconfig`, `vitest.config`, `.gitignore`, `.env.example`, `README.md`, `Dockerfile`, `docker-compose.yml`.
- `src/` carries env loader, db client + helpers + migration runner, S3 storage layer, envelope/auth/household middleware, all 12 route groups (health, auth, households, locations, tags, seeds, random, photos, catalog, extractions, subscriptions), better-auth instance, Apple receipt validation library.
- Migrations apply cleanly: `0001_initial.sql` (14 domain tables) + `0002_tier_and_subscriptions.sql` (`users.tier` + `subscriptions` table).
- `bun test` → **13/13 unit tests pass** (randomPick + confidence policies).
- `bun run dev` boots; `docker compose up db minio minio-bootstrap` brings up backing services.
- **F1 28/28 route smoke checks pass** + **F5 7/7 tier-aware smoke checks pass** (subscription state, tier gating both directions, catalog row creation).

## Blockers

- `ANTHROPIC_API_KEY` unset in `.env`; the `/api/extractions` route correctly returns 503 `not_configured` for hosted-tier requests until configured.
- `APPLE_IAP_SHARED_SECRET` unset; `/api/subscriptions/verify` returns 503 until configured.

## Hono port-time gotcha (F1e learning)

`subrouter.use('*', ...)` bleeds across sibling subrouters mounted at the same prefix. We compose middleware per-route now (`route(path, ...auth, handler)`) instead of at the subrouter level. The Workers attempt didn't trip on this only because its smoke ordering masked the issue.

## Next concrete step

Server side is feature-complete for the F1–F5 Phase 1 pivot. Production hand-off items:

1. Configure `APPLE_IAP_SHARED_SECRET` (App Store Connect → My Apps → App Information → App-Specific Shared Secret) so the `POST /api/subscriptions/verify` route can hit Apple's verifyReceipt successfully.
2. Configure `ANTHROPIC_API_KEY` for production hosted-tier extractions.
3. Deploy to a real host (Fly.io / Railway / Docker on a VPS). The `Dockerfile` + `docker-compose.yml` make this turn-key.
4. Subsequent backlog items (post-Phase-1): catalog moderation admin UI, App Store Server Notifications (S2S) for receipt revalidation cron, Phase 2 server features (garden plans, weather, extension calendars).
