#!/usr/bin/env bash
# deploy.sh — guarded Fly deploy for seedkeep-server.
#
# Guards:
#   1. Refuse a dirty working tree (--dirty to override, prints diffstat).
#   2. Run typecheck (tsc --noEmit).
#   3. Run unit tests (vitest).
#   4. Run integration tests if Postgres is reachable; warn + skip if not.
#   5. fly deploy (uses fly.toml in the repo root).
#   6. Post-deploy curl of /api/health and print the response.
#
# Usage:
#   scripts/deploy.sh [--dirty]
#
# The --dirty flag is an explicit escape hatch for emergencies. It prints
# the diffstat so the operator knows exactly what they're shipping.

set -euo pipefail

DIRTY_OK=false
for arg in "$@"; do
  if [[ "$arg" == "--dirty" ]]; then
    DIRTY_OK=true
  fi
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── 1. Working tree check ────────────────────────────────────────────────
if ! git diff --quiet || ! git diff --cached --quiet; then
  if [[ "$DIRTY_OK" == "true" ]]; then
    echo "[deploy] WARNING: deploying with uncommitted changes (--dirty):"
    git diff --stat HEAD
    echo ""
  else
    echo "[deploy] ERROR: working tree is dirty. Commit or stash your changes,"
    echo "         or re-run with --dirty to override (prints diffstat)."
    exit 1
  fi
fi

# ── 2. Typecheck ─────────────────────────────────────────────────────────
echo "[deploy] running typecheck..."
bun run typecheck

# ── 3. Unit tests ────────────────────────────────────────────────────────
echo "[deploy] running unit tests..."
bun run test

# ── 4. Integration tests ─────────────────────────────────────────────────
DB_URL="${DATABASE_URL:-postgres://seedkeep:dev-only@localhost:5432/seedkeep}"
PG_REACHABLE=false
if command -v pg_isready &>/dev/null; then
  if pg_isready --quiet --dbname="$DB_URL" 2>/dev/null; then
    PG_REACHABLE=true
  fi
fi

if [[ "$PG_REACHABLE" == "true" ]]; then
  echo "[deploy] running integration tests..."
  DATABASE_URL="$DB_URL" bun test tests/integration/
else
  echo "[deploy] WARNING: Postgres not reachable — skipping integration tests."
  echo "         Run 'docker compose up -d postgres' then re-run to include them."
fi

# ── 5. Fly deploy ────────────────────────────────────────────────────────
echo "[deploy] deploying to Fly..."
fly deploy

# ── 6. Health check ──────────────────────────────────────────────────────
# Give the new instance a moment to start accepting traffic.
sleep 5
APP_URL="https://seedkeep-server.fly.dev"
echo "[deploy] checking ${APP_URL}/api/health..."
curl -sf "${APP_URL}/api/health" | python3 -m json.tool || \
  echo "[deploy] WARNING: health check returned non-200 or invalid JSON"

echo "[deploy] done"
