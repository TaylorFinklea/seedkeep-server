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

## Web clients

The browser app signs in with an emailed one-time code and then calls the API with an HttpOnly session cookie. Native iOS clients keep using Bearer tokens.

- **Allowed origins.** `APP_ORIGINS` is a comma-separated list of exact web origins, for example `https://app-staging.seedkeep.app` or `https://app.seedkeep.app`. Development also allows `http://localhost:*` and `http://127.0.0.1:*`. Production does not.
- **Public URL.** `PUBLIC_BASE_URL` is the URL clients use to reach this server. Staging requires it. Production defaults to `https://seedkeep-server.fly.dev`, which the claude.ai OAuth issuer depends on. Do not change that default.
- **Mail.** `MAIL_PROVIDER` is `resend`, `log` or `memory`. `resend` needs `RESEND_API_KEY`. `MAIL_FROM` defaults to `Seedkeep <login@seedkeep.app>`. `log` prints codes to the console and is refused in staging and production. If `MAIL_PROVIDER` is unset, it defaults to `log` in development and to no mailer elsewhere. With no mailer, sign-in code requests return `503 mail_not_configured`.
- **Sign-in.** `POST /api/auth/email-otp/send-verification-otp` with `{ "email", "type": "sign-in" }`, then `POST /api/auth/sign-in/email-otp` with `{ "email", "otp" }`. Codes are 6 digits, expire after 5 minutes and allow 3 attempts. Sending is limited to 3 per minute per client IP, and the client IP comes from the `fly-client-ip` header.
- **Cookie.** The session cookie is `__Secure-better-auth.session_token` outside development. It is HttpOnly, SameSite=Lax, Path=/ and host-only.
- **CSRF.** Cookie-authenticated unsafe requests (POST, PUT, PATCH, DELETE) need an `Origin` header from `APP_ORIGINS`. Otherwise they get `403 csrf_origin_rejected`. Bearer requests are not affected.
- **Households.** `GET /api/households` lists the caller's households, newest first. Send `X-Household-Id` to choose which household a request acts on. A household the caller does not belong to gets `403 household_forbidden`. Without the header, the newest membership is used, as before.

## Deploying

Deploys go through `scripts/deploy.sh`. It takes a required target, so there is no default environment.

```bash
scripts/deploy.sh staging      # fly.staging.toml -> app seedkeep-server-staging
scripts/deploy.sh production   # fly.toml -> app seedkeep-server
```

The script runs these steps in order, and any failure stops it before anything is deployed:

1. Refuses a dirty tree. Untracked files count, so commit or remove them first.
2. Runs `bun run typecheck`.
3. Recreates the local `seedkeep_deploygate` database, migrates it, and runs `bun run test` and `bun test tests/integration/` against it. Each gate command runs under `env -i` with an explicit allowlist (`PATH`, `HOME`, the dummy CI values and the local `DATABASE_URL`). Real settings in your shell, such as `APP_ENV`, `MAIL_PROVIDER`, `RESEND_API_KEY`, `ANTHROPIC_API_KEY` or a remote `DATABASE_URL`, never reach the gate. It requires the local Postgres from `docker compose up -d db`.
4. For production only, asks you to type `production`. Set `CONFIRM=production` to skip the prompt in automation.
5. Runs `fly deploy --config <config> --app <app>`.
6. Polls `/api/health` on the public host for up to 120 seconds and exits non-zero if it never reports healthy.

Secrets are not in the Fly config files. Set them per app with `fly secrets set --app <app>`, for example `DATABASE_URL`, `S3_*`, `BETTER_AUTH_SECRET`, `APPLE_*`, `RESEND_API_KEY` and `ANTHROPIC_API_KEY`. `fly.staging.toml` sets the non-secret staging values: `APP_ENV`, `PUBLIC_BASE_URL`, `APP_ORIGINS`, `MAIL_PROVIDER` and `MAIL_FROM`.

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
