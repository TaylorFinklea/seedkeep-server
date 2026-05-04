# Roadmap

> Durable goals and milestones. Updated when scope changes, not every session.

## Vision

Self-hostable backend for Seedkeep. Phase 1 ships per-household inventory + AI-curated catalog + Apple-IAP-gated hosted-AI tier. Pairs with `seedkeep-ios`.

## Now / Next / Later

### Now (F1: bootstrap — COMPLETE)
- [x] F1a: Repo skeleton (package.json, tsconfig, .gitignore, .env.example, README, .docs/ai/)
- [x] F1b: Postgres migration runner + 0001_initial.sql (15 tables incl. `_seedkeep_migrations`)
- [x] F1c: S3-compatible storage layer — round-trip verified through MinIO
- [x] F1d: Middleware (envelope, auth, household) + index + Bun.serve entry — `/api/health` live
- [x] F1e: All 11 route groups ported. **26/28 smoke checks pass** against Postgres + MinIO. The 2 photo-upload checks were blocked by host disk pressure (MinIO refuses writes when disk <1% free); the code path was verified earlier with a clean storage round-trip.
- [x] F1f: Pure-function tests (randomPick + confidence) — 13/13 vitest passing
- [x] F1g: Dockerfile multi-stage + docker-compose with Postgres + MinIO + bootstrap bucket
- [x] F1h: Handoff docs + final commit

### Next (F2: tier + subscriptions)
- [ ] Migration 0002: `users.tier` column + `subscriptions` table
- [ ] `POST /api/subscriptions/verify` Apple IAP receipt validation
- [ ] Branch `/api/extractions` on `users.tier` (free/byok pre-extracted JSON; hosted server-side vision)

### Later
- [ ] Production deploy automation (Fly/Railway scripts)
- [ ] Catalog moderation admin UI
- [ ] Phase 2 server features (garden plans, weather, extension calendars)

## Milestones

### M1: Phase 1 server complete
- [ ] All 28 route checks pass against Postgres + MinIO
- [ ] iOS app round-trips via Settings → Server URL switch
- [ ] BYOK pre-extracted JSON path works end-to-end
- [ ] Hosted-tier subscription gates server-side extraction

## Constraints

- **Self-hostable from day one** — every dependency must run on Fly/Railway/Docker, not just on Cloudflare.
- **Stateless server** — no in-process state (so we can scale horizontally and self-host on serverless platforms).
- **Postgres + S3-compatible only** — no proprietary cloud APIs in the hot path.
- **Hono everywhere** — keep the route handlers runtime-agnostic so we can ship Workers as an alternate target later if it becomes useful.

## Backlog

<!-- Add items as they get scoped. Each entry: Scope, Files, Acceptance, Verify, Tier hint. -->
