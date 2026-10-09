#!/usr/bin/env bash
# deploy.sh — guarded Fly deploy for seedkeep-server.
#
# Usage:
#   scripts/deploy.sh <staging|production>
#
# There is no default environment. Every target goes through the same gate:
#   1. Refuse a dirty tree. Untracked files count (git status --porcelain).
#   2. Explicit typecheck.
#   3. Unit and integration tests against an isolated local database,
#      seedkeep_deploygate. DATABASE_URL is overridden, so a remote
#      DATABASE_URL in the environment is never used by the gate.
#   4. Production only: typed confirmation, unless CONFIRM=production is set.
#   5. fly deploy --config <config> --app <app>.
#   6. Poll the public /api/health for up to 120 seconds. A failed health
#      check exits non-zero.
#
# Targets:
#   staging     fly.staging.toml  app seedkeep-server-staging
#               https://api-staging.seedkeep.app
#   production  fly.toml          app seedkeep-server
#               https://seedkeep-server.fly.dev

set -euo pipefail

usage() {
  echo "usage: scripts/deploy.sh <staging|production>" >&2
  exit 2
}

if [[ $# -ne 1 ]]; then
  usage
fi

case "$1" in
  staging)
    FLY_CONFIG="fly.staging.toml"
    FLY_APP="seedkeep-server-staging"
    HEALTH_BASE="https://api-staging.seedkeep.app"
    ;;
  production)
    FLY_CONFIG="fly.toml"
    FLY_APP="seedkeep-server"
    HEALTH_BASE="https://seedkeep-server.fly.dev"
    ;;
  *)
    echo "[deploy] ERROR: unknown environment '$1'" >&2
    usage
    ;;
esac
DEPLOY_ENV="$1"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── 1. Working tree check (tracked changes AND untracked files) ──────────
if [[ -n "$(git status --porcelain)" ]]; then
  echo "[deploy] ERROR: working tree is dirty (including untracked files):" >&2
  git status --short >&2
  echo "[deploy] Commit, stash, or remove these files, then re-run." >&2
  exit 1
fi

# ── 2. Gate ──────────────────────────────────────────────────────────────
# Local development credentials only (same as docker-compose and CI). These
# never point at a remote host.
GATE_ADMIN_URL="postgres://seedkeep:dev-only@localhost:5432/postgres"
GATE_DB_URL="postgres://seedkeep:dev-only@localhost:5432/seedkeep_deploygate"

# Every gate command runs under `env -i` with an explicit allowlist. Nothing
# else from the calling shell reaches the gate: no APP_ENV, MAIL_PROVIDER,
# RESEND_API_KEY, ANTHROPIC_API_KEY, or a remote DATABASE_URL. The secret-like
# values are dummies, as in CI. No gate test contacts S3, Apple, Anthropic or
# Resend.
gate() {
  env -i \
    PATH="$PATH" \
    HOME="$HOME" \
    DATABASE_URL="$GATE_DB_URL" \
    S3_ACCESS_KEY_ID="ci-dummy-key" \
    S3_SECRET_ACCESS_KEY="ci-dummy-secret" \
    S3_BUCKET="ci-dummy-bucket" \
    BETTER_AUTH_SECRET="ci-better-auth-secret-32chars-xxxxx" \
    APPLE_CLIENT_ID="ci-apple-client" \
    APPLE_CLIENT_SECRET="ci-apple-secret" \
    "$@"
}

echo "[deploy] typecheck..."
gate bun run typecheck

echo "[deploy] recreating local database seedkeep_deploygate..."
env -i PATH="$PATH" HOME="$HOME" GATE_ADMIN_URL="$GATE_ADMIN_URL" bun -e '
  import postgres from "postgres";
  const sql = postgres(process.env.GATE_ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe("DROP DATABASE IF EXISTS seedkeep_deploygate WITH (FORCE)");
    await sql.unsafe("CREATE DATABASE seedkeep_deploygate");
  } finally {
    await sql.end({ timeout: 5 });
  }
'

echo "[deploy] migrating seedkeep_deploygate..."
gate bun run migrate

echo "[deploy] unit tests (vitest)..."
gate bun run test

echo "[deploy] integration tests..."
gate bun test tests/integration/

echo "[deploy] gate passed."

# ── 4. Production confirmation ───────────────────────────────────────────
if [[ "$DEPLOY_ENV" == "production" && "${CONFIRM:-}" != "production" ]]; then
  answer=""
  read -r -p "[deploy] Type 'production' to deploy seedkeep-server to PRODUCTION: " answer || true
  if [[ "$answer" != "production" ]]; then
    echo "[deploy] ERROR: confirmation not given. Nothing deployed." >&2
    exit 1
  fi
fi

# ── 5. Fly deploy ────────────────────────────────────────────────────────
echo "[deploy] deploying ${FLY_APP} with ${FLY_CONFIG}..."
fly deploy --config "$FLY_CONFIG" --app "$FLY_APP"

# ── 6. Health check (poll up to 120s) ────────────────────────────────────
HEALTH_URL="${HEALTH_BASE}/api/health"
echo "[deploy] polling ${HEALTH_URL} for up to 120 seconds..."
deadline=$(( $(date +%s) + 120 ))
healthy=false
body=""
while [[ $(date +%s) -lt $deadline ]]; do
  if body="$(curl -sf --max-time 10 "$HEALTH_URL" 2>/dev/null)" && [[ "$body" == *'"ok":true'* ]]; then
    healthy=true
    break
  fi
  sleep 5
done

if [[ "$healthy" != "true" ]]; then
  echo "[deploy] ERROR: health check failed for ${HEALTH_URL} within 120 seconds." >&2
  exit 1
fi

echo "[deploy] healthy: ${body}"
echo "[deploy] done (${DEPLOY_ENV})"
