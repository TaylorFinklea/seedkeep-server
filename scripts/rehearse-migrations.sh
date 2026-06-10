#!/usr/bin/env bash
# rehearse-migrations.sh — restore latest prod backup into local docker-compose
# Postgres, run all migrations, then run the integration test suite.
#
# Use before deploying a new migration to verify it applies cleanly against
# a prod-shaped database.
#
# Usage:
#   scripts/rehearse-migrations.sh [YYYY-MM-DD]
#
# If a date is not supplied, it attempts to find and use the most recent
# backup by listing s3://BUCKET/backups/ and sorting lexicographically
# (YYYY-MM-DD filenames sort correctly).
#
# Prerequisites:
#   - docker compose up -d postgres
#   - pg_restore + pg_isready in PATH
#   - AWS CLI in PATH
#   - S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY set in env or .env
#   - DATABASE_URL pointing to the local docker-compose Postgres
#
# CAUTION: this WIPES the local database and replaces it with the backup.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Load .env if present and not already set.
if [[ -f .env && -z "${DATABASE_URL:-}" ]]; then
  set -a; source .env; set +a
fi

DB_URL="${DATABASE_URL:-postgres://seedkeep:dev-only@localhost:5432/seedkeep}"
BUCKET="${S3_BUCKET:?S3_BUCKET must be set}"
REGION="${S3_REGION:-us-east-1}"

# ── Find the most recent backup date if none supplied ────────────────────
DATE="${1:-}"
if [[ -z "$DATE" ]]; then
  ENDPOINT_ARG=""
  if [[ -n "${S3_ENDPOINT:-}" ]]; then
    ENDPOINT_ARG="--endpoint-url ${S3_ENDPOINT}"
  fi
  echo "[rehearse] finding latest backup in s3://${BUCKET}/backups/..."
  DATE=$(
    AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID}" \
    AWS_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY}" \
    AWS_DEFAULT_REGION="${REGION}" \
    aws s3 ls ${ENDPOINT_ARG} "s3://${BUCKET}/backups/" 2>/dev/null \
    | grep "\.dump\.gz" \
    | awk '{print $4}' \
    | sed 's/seedkeep-\(.*\)\.dump\.gz/\1/' \
    | sort \
    | tail -1
  )
  if [[ -z "$DATE" ]]; then
    echo "[rehearse] ERROR: no backups found in s3://${BUCKET}/backups/"
    echo "           Run scripts/backup.ts first, or supply a date argument."
    exit 1
  fi
  echo "[rehearse] using latest backup: ${DATE}"
fi

# ── Check Postgres is running ────────────────────────────────────────────
if ! pg_isready --quiet --dbname="$DB_URL" 2>/dev/null; then
  echo "[rehearse] ERROR: Postgres not reachable at ${DB_URL}"
  echo "           Run: docker compose up -d postgres"
  exit 1
fi

# ── Restore backup ───────────────────────────────────────────────────────
echo "[rehearse] restoring backup ${DATE}..."
DATABASE_URL="$DB_URL" \
S3_BUCKET="$BUCKET" \
S3_REGION="$REGION" \
S3_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID}" \
S3_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY}" \
S3_ENDPOINT="${S3_ENDPOINT:-}" \
bash scripts/restore-backup.sh "$DATE"

# ── Run migrations ───────────────────────────────────────────────────────
echo "[rehearse] running migrations..."
DATABASE_URL="$DB_URL" bun run migrate

# ── Run integration tests ────────────────────────────────────────────────
echo "[rehearse] running integration tests..."
DATABASE_URL="$DB_URL" bun test tests/integration/

echo "[rehearse] done — migrations applied cleanly on ${DATE} prod snapshot"
