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
- **28/28 route smoke checks pass** end-to-end (F1 fully verified after disk freed up).
- F2 complete: tier + subscriptions schema live, IAP verify route works, extraction routes branch on tier.

## Blockers

- `ANTHROPIC_API_KEY` unset in `.env`; the `/api/extractions` route correctly returns 503 `not_configured` for hosted-tier requests until configured.
- `APPLE_IAP_SHARED_SECRET` unset; `/api/subscriptions/verify` returns 503 until configured.

## Hono port-time gotcha (F1e learning)

`subrouter.use('*', ...)` bleeds across sibling subrouters mounted at the same prefix. We compose middleware per-route now (`route(path, ...auth, handler)`) instead of at the subrouter level. The Workers attempt didn't trip on this only because its smoke ordering masked the issue.

## Next concrete step

F3 — iOS Server URL picker + on-device extraction. Bump the iOS deployment target to 18.1, add `Settings → Server` (URL field with `/api/health` validation), build an `OnDeviceExtractor` that wraps Apple Foundation Models, and update `ScanFlow` to call it then POST `/api/extractions/pre-extracted`.
