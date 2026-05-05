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

### Next (F2: tier + subscriptions — COMPLETE)
- [x] Migration 0002: `users.tier` column + `subscriptions` table
- [x] `POST /api/subscriptions/verify` Apple IAP receipt validation (auto-falls-back production → sandbox per Apple's recipe)
- [x] `GET /api/subscriptions/me` for tier + current subscription state
- [x] `POST /api/extractions` now requires `tier=hosted` (returns 402 `wrong_tier` for free/byok)
- [x] `POST /api/extractions/pre-extracted` for free + byok — accepts client-extracted JSON + optional photos; persists to catalog using self_confidence as the review proxy

### Later
- [ ] Production deploy automation (Fly/Railway scripts)
- [ ] Catalog moderation admin UI (revisit the trust-the-self_confidence shortcut once we have real users)
- [ ] App Store Server Notifications (S2S) for receipt revalidation cron
- [ ] Phase 2 server features (garden plans, weather, extension calendars)

## Milestones

### M1: Phase 1 server complete — ✅ achieved 2026-05-04
- [x] All 28 route checks pass against Postgres + MinIO (F1)
- [x] iOS app round-trips via Settings → Server URL switch (F3 in iOS repo)
- [x] BYOK pre-extracted JSON path works end-to-end (smoke verified F5)
- [x] Hosted-tier subscription gates server-side extraction (smoke verified F5: 402 wrong_tier for free, 503 not_configured-on-Anthropic for hosted)

### M2: Phase 1 production-ready (post-Phase-1)
- [ ] `APPLE_IAP_SHARED_SECRET` + `ANTHROPIC_API_KEY` configured in production env
- [ ] Deployed to Fly.io / Railway / Docker on a VPS
- [ ] App Store Connect products `app.seedkeep.hosted.{monthly,yearly}` registered + sandbox-tested with real iOS client

## Constraints

- **Self-hostable from day one** — every dependency must run on Fly/Railway/Docker, not just on Cloudflare.
- **Stateless server** — no in-process state (so we can scale horizontally and self-host on serverless platforms).
- **Postgres + S3-compatible only** — no proprietary cloud APIs in the hot path.
- **Hono everywhere** — keep the route handlers runtime-agnostic so we can ship Workers as an alternate target later if it becomes useful.

## Backlog

<!-- Add items as they get scoped. Each entry: Scope, Files, Acceptance, Verify, Tier hint. -->
