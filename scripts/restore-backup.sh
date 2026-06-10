#!/usr/bin/env bash
# restore-backup.sh — restore a seedkeep S3 backup into the local docker-compose Postgres.
#
# Usage:
#   scripts/restore-backup.sh [YYYY-MM-DD]
#
# If a date is not supplied the script lists available backups and exits so
# you can pick one explicitly.
#
# Prerequisites:
#   - docker compose up -d postgres  (local Postgres on localhost:5432)
#   - pg_restore in PATH (brew install postgresql or apt install postgresql-client)
#   - AWS CLI in PATH (aws s3 cp is used for the download; env vars configure auth)
#
# Environment variables (read from .env or the shell):
#   DATABASE_URL        — postgres://seedkeep:dev-only@localhost:5432/seedkeep
#   S3_BUCKET           — bucket name
#   S3_ENDPOINT         — optional non-AWS endpoint (e.g. MinIO/R2)
#   S3_ACCESS_KEY_ID    — AWS-compatible access key
#   S3_SECRET_ACCESS_KEY
#   S3_REGION           — default us-east-1
#
# Example:
#   DATABASE_URL=postgres://seedkeep:dev-only@localhost:5432/seedkeep \
#   S3_BUCKET=seedkeep-prod-storage \
#   S3_ACCESS_KEY_ID=AKIA... \
#   S3_SECRET_ACCESS_KEY=... \
#   scripts/restore-backup.sh 2026-06-10

set -euo pipefail

DATE="${1:-}"
BUCKET="${S3_BUCKET:?S3_BUCKET must be set}"
REGION="${S3_REGION:-us-east-1}"
DB_URL="${DATABASE_URL:-postgres://seedkeep:dev-only@localhost:5432/seedkeep}"

ENDPOINT_ARG=""
if [[ -n "${S3_ENDPOINT:-}" ]]; then
  ENDPOINT_ARG="--endpoint-url ${S3_ENDPOINT}"
fi

if [[ -z "$DATE" ]]; then
  echo "Available backups:"
  AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID}" \
  AWS_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY}" \
  AWS_DEFAULT_REGION="${REGION}" \
  aws s3 ls ${ENDPOINT_ARG} "s3://${BUCKET}/backups/" | grep "\.dump\.gz" || true
  echo ""
  echo "Re-run with a date argument: $0 YYYY-MM-DD"
  exit 0
fi

BACKUP_KEY="backups/seedkeep-${DATE}.dump.gz"
TMP_GZ="$(mktemp /tmp/seedkeep-restore-XXXXXX.dump.gz)"
TMP_DUMP="${TMP_GZ%.gz}"

echo "[restore] downloading s3://${BUCKET}/${BACKUP_KEY}"
AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID}" \
AWS_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY}" \
AWS_DEFAULT_REGION="${REGION}" \
aws s3 cp ${ENDPOINT_ARG} "s3://${BUCKET}/${BACKUP_KEY}" "${TMP_GZ}"

echo "[restore] decompressing"
gunzip -f "${TMP_GZ}"
# gunzip removes the .gz suffix

echo "[restore] restoring into ${DB_URL}"
# --clean drops objects before recreating them so re-runs are idempotent.
# --if-exists suppresses errors for objects that don't exist yet.
# --no-acl / --no-owner skip ownership metadata that won't match locally.
pg_restore \
  --clean \
  --if-exists \
  --no-acl \
  --no-owner \
  --dbname="${DB_URL}" \
  "${TMP_DUMP}"

rm -f "${TMP_DUMP}"
echo "[restore] done — local DB now reflects backup ${DATE}"
