# Current State

> Updated at the end of every work session. Read this first.

## Active Branch

`main`

## Last Session Summary

**Date**: 2026-05-04

- F1 complete. Repo bootstrapped after the architecture pivot from Cloudflare Workers to portable Bun + Postgres + S3.
- The prior Workers attempt is preserved at `~/git/seedkeep` tagged `phase-1-workers-attempt`.
- ~70% of the route logic + tests carried over from that repo and now run against Postgres + MinIO.
- Sister repo `~/git/seedkeep-ios` (5 commits, Phase 1 iOS app feature-complete) will keep working unchanged once pointed at the new server — HTTP contracts are stable.

## Build Status

- F1 complete. Repo has: `package.json`, `tsconfig`, `vitest.config`, `.gitignore`, `.env.example`, `README.md`, `Dockerfile`, `docker-compose.yml`.
- `src/` carries env loader, db client + helpers + migration runner, S3 storage layer, envelope/auth/household middleware, all 11 route groups (health, auth, households, locations, tags, seeds, random, photos, catalog, extractions), better-auth instance.
- `migrations/0001_initial.sql` applies cleanly against Postgres 16 (36 statements, 14 domain tables + `_seedkeep_migrations`).
- `bun run test` → 13/13 vitest tests pass (randomPick + confidence policies).
- `bun run dev` boots; `docker compose up db minio minio-bootstrap` brings up backing services.
- **26/28 route smoke checks pass** against the new stack. The 2 photo-upload checks are blocked by host disk pressure (MinIO refuses writes when free space <1%) — environmental, not a code issue. Storage layer was verified earlier with a clean put/get/delete round-trip.

## Blockers

- **Host disk at 99% capacity** — MinIO threshold blocks photo writes. Requires user-side disk cleanup; nothing on the seedkeep side to fix.
- `ANTHROPIC_API_KEY` unset in `.env`; the `/api/extractions` route correctly returns 503 `not_configured` when missing.

## Hono port-time gotcha (F1e learning)

`subrouter.use('*', ...)` bleeds across sibling subrouters mounted at the same prefix. We compose middleware per-route now (`route(path, ...auth, handler)`) instead of at the subrouter level. The Workers attempt didn't trip on this only because its smoke ordering masked the issue.

## Next concrete step

F2 — tier + subscriptions schema:

1. Migration `0002_tier_and_subscriptions.sql`: add `users.tier` column (default `'free'`); create `subscriptions` table (Apple receipt fields, expires_at, original_transaction_id, last_verified_at).
2. New `src/routes/subscriptions.ts` with `POST /api/subscriptions/verify` (calls Apple's verifyReceipt endpoint).
3. Branch `/api/extractions` on `users.tier`: free/byok accept pre-extracted JSON from client; hosted runs server-side vision.
