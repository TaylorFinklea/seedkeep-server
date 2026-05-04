# Current State

> Updated at the end of every work session. Read this first.

## Active Branch

`main`

## Last Session Summary

**Date**: 2026-05-04

- Repo bootstrapped after the architecture pivot from Cloudflare Workers to portable Bun + Postgres + S3.
- The prior Workers attempt is preserved at `~/git/seedkeep` tagged `phase-1-workers-attempt`.
- ~70% of the route logic + tests carry over from that repo; F1 sub-phases handle the porting.
- Sister repo `~/git/seedkeep-ios` (5 commits, iOS app feature-complete for Phase 1 against the old Workers contract) keeps working unchanged once we point it at the new server — HTTP contracts are stable.

## Build Status

- Repo initialized; package.json + tsconfig + .gitignore + .env.example + README + .docs/ai/ in place.
- No `src/` content yet — that's F1b/c/d/e.

## Blockers

- None. Bun 1.3.13 is installed; Docker Desktop available for the compose stack.

## Next concrete step

F1b: write `src/db/{client,helpers,migrate}.ts` and `migrations/0001_initial.sql` (Postgres-flavored). Verify by `docker compose up db` then `bun run migrate` and confirming all Phase 1 tables exist via psql.
