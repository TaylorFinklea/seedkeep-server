# Seedkeep Server

Backend for [Seedkeep](https://github.com/TaylorFinklea/seedkeep-ios), a household garden OS that starts as a seed-inventory replacement and grows into a planner, journal, AI assistant, and plant-care companion.

Built on **Bun + Hono + PostgreSQL + S3-compatible object storage**. Designed to be self-hostable from day one — run our hosted version, or your own on Fly.io / Railway / Docker / bare metal.

## Quick start (local development)

```bash
# 1. Install dependencies
bun install

# 2. Set up environment
cp .env.example .env
# Edit .env if you want non-default values. Defaults work with the bundled docker-compose stack.

# 3. Bring up Postgres + MinIO + the server
docker compose up -d

# 4. Apply database migrations (one-time)
bun run migrate

# 5. Verify it's running
curl http://localhost:8787/api/health
# → { "ok": true, "data": { "status": "healthy", "env": "development" } }
```

The compose stack maps:

- **Postgres**: `localhost:5432` (user `seedkeep`, password `dev-only`)
- **MinIO**: `localhost:9000` (S3 API), `localhost:9001` (console — login `minio` / `dev-only-secret`)
- **App**: `localhost:8787`

## Without Docker (host-installed Postgres + S3)

```bash
# Point DATABASE_URL and S3_* in .env at your existing services
bun install
bun run migrate
bun run dev
```

## Stack

- **Runtime**: [Bun](https://bun.sh) ≥ 1.1
- **HTTP**: [Hono](https://hono.dev) — runtime-agnostic router
- **Database**: PostgreSQL 16+ (`postgres` driver)
- **Auth**: [better-auth](https://www.better-auth.com) with Sign in with Apple
- **Object storage**: any S3-compatible service via `@aws-sdk/client-s3` (R2, AWS S3, MinIO, Backblaze B2, Wasabi, …)

## Self-hosting

Seedkeep is designed for self-hosting as a first-class workflow:

1. Set `DATABASE_URL` to your Postgres instance.
2. Set `S3_*` to your object storage of choice (MinIO, R2, AWS S3, etc.).
3. Set `BETTER_AUTH_SECRET` to a random 32+ byte string.
4. Set `APPLE_CLIENT_ID` and `APPLE_CLIENT_SECRET` to your Apple Sign-In credentials.
5. Run migrations once: `bun run migrate`.
6. Run the server: `bun run start` (or build a container with the included `Dockerfile`).
7. Point your iOS Seedkeep app at your URL via Settings → Server.

The repo ships a multi-stage `Dockerfile` and a working `docker-compose.yml` you can drop on any Docker host.

## Repo layout

```
seedkeep-server/
  src/
    server.ts                   Bun.serve entry
    index.ts                    Hono app, mounts middleware + routes
    env.ts                      zod-validated environment loader
    db/                         Postgres client + helpers + migration runner
    middleware/                 envelope, auth, household
    routes/                     /api/* route handlers
    lib/                        Pure helpers (sync, randomPick, extraction policy, storage)
  migrations/
    0001_initial.sql            Postgres-flavored schema
  Dockerfile                    Multi-stage Bun build
  docker-compose.yml            Postgres + MinIO + the server, for local dev / self-host
  .env.example                  Required env vars, documented
```

## Architecture

See `/Users/tfinklea/.claude/plans/let-s-start-planning-this-generic-rocket.md` for the full Phase 1 plan and the `phase-1-workers-attempt` tag in the sibling `~/git/seedkeep` repo for the prior Cloudflare Workers iteration we migrated away from.
