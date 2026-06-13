/**
 * Nightly pg_dump → S3 backup.
 *
 * Called from the worker's daily sentinel. Dumps the database in custom
 * format, compresses with gzip, streams the result directly into S3 via
 * multipart upload (@aws-sdk/lib-storage Upload). No intermediate heap
 * buffer — safe on the 256MB always-on worker VM.
 *
 * Requires pg_dump in PATH (added to the Dockerfile via postgresql client
 * package matching the Postgres major version).
 *
 * Self-hostable: relies only on DATABASE_URL + the same S3 env vars used
 * by the app. No Fly-specific APIs.
 *
 * Usage (called by worker, or manually):
 *   bun run scripts/backup.ts
 *
 * Manual end-to-end rehearse against local MinIO (docker-compose includes
 * a MinIO service on port 9000):
 *
 *   # 1. Start local stack
 *   docker compose up -d --wait db minio minio-bootstrap
 *
 *   # 2. Create the backups bucket in MinIO (one-time, if not already done)
 *   AWS_ACCESS_KEY_ID=minio AWS_SECRET_ACCESS_KEY=dev-only-secret \
 *     aws --endpoint-url http://localhost:9000 s3 mb s3://seedkeep-backups 2>/dev/null || true
 *
 *   # 3. Run migrations
 *   DATABASE_URL=postgres://seedkeep:dev-only@localhost:5432/seedkeep bun run migrate
 *
 *   # 4. Run backup against local MinIO
 *   DATABASE_URL=postgres://seedkeep:dev-only@localhost:5432/seedkeep \
 *   S3_ENDPOINT=http://localhost:9000 \
 *   S3_REGION=us-east-1 \
 *   S3_ACCESS_KEY_ID=minio \
 *   S3_SECRET_ACCESS_KEY=dev-only-secret \
 *   S3_BUCKET=seedkeep-backups \
 *   S3_FORCE_PATH_STYLE=true \
 *   bun run scripts/backup.ts
 *
 *   # 5. (Optional) Full rehearse with restore + migration + integration tests
 *   S3_ENDPOINT=http://localhost:9000 \
 *   S3_ACCESS_KEY_ID=minio \
 *   S3_SECRET_ACCESS_KEY=dev-only-secret \
 *   S3_BUCKET=seedkeep-backups \
 *   S3_REGION=us-east-1 \
 *   S3_FORCE_PATH_STYLE=true \
 *   DATABASE_URL=postgres://seedkeep:dev-only@localhost:5432/seedkeep \
 *   bash scripts/rehearse-migrations.sh
 */

import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { loadEnv } from '../src/env';
import { createGzip } from 'node:zlib';

const RETENTION_DAYS = 30;
const BACKUP_PREFIX = 'backups/';

function getS3Client(env: ReturnType<typeof loadEnv>): S3Client {
  return new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  });
}

export async function runBackup(env: ReturnType<typeof loadEnv>): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const key = `${BACKUP_PREFIX}seedkeep-${today}.dump.gz`;

  console.log(`[backup] starting pg_dump → ${key}`);

  // pg_dump -Fc writes custom format to stdout; pipe through gzip.
  const dumpProcess = spawn('pg_dump', ['--format=custom', env.DATABASE_URL], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const gzip = createGzip();
  dumpProcess.stdout.pipe(gzip);

  // Collect stderr for error reporting.
  const stderrChunks: Buffer[] = [];
  dumpProcess.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  // Reject the backup promise if pg_dump fails to spawn (ENOENT) or errors.
  let rejectBackup: ((err: Error) => void) | null = null;
  const spawnErrorPromise = new Promise<never>((_resolve, reject) => {
    rejectBackup = reject;
    dumpProcess.on('error', (err) => reject(new Error(`pg_dump spawn error: ${err.message}`)));
    gzip.on('error', (err) => reject(new Error(`gzip stream error: ${err.message}`)));
  });

  // Stream the gzip output directly to S3 via multipart upload — no heap buffer.
  const s3 = getS3Client(env);
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: gzip as unknown as Readable,
      ContentType: 'application/gzip',
    },
  });

  // Race the upload against spawn/stream errors so an ENOENT rejects quickly.
  const exitCodePromise = new Promise<number>((resolve) => {
    dumpProcess.on('close', resolve);
  });

  await Promise.race([
    Promise.all([upload.done(), exitCodePromise]).then(([, exitCode]) => {
      if (exitCode !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString();
        throw new Error(`pg_dump exited with code ${exitCode}: ${stderr}`);
      }
    }),
    spawnErrorPromise,
  ]);

  // Silence the unused rejectBackup reference (only used in the error handlers).
  void rejectBackup;

  console.log(`[backup] uploaded ${key}`);

  // Sweep backups older than RETENTION_DAYS.
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
  const cutoffPrefix = `${BACKUP_PREFIX}seedkeep-${cutoffDate.toISOString().slice(0, 10)}`;

  const list = await s3.send(new ListObjectsV2Command({
    Bucket: env.S3_BUCKET,
    Prefix: BACKUP_PREFIX,
  }));

  const toDelete = (list.Contents ?? [])
    .filter((obj) => obj.Key && obj.Key < cutoffPrefix)
    .map((obj) => ({ Key: obj.Key! }));

  if (toDelete.length > 0) {
    await s3.send(new DeleteObjectsCommand({
      Bucket: env.S3_BUCKET,
      Delete: { Objects: toDelete },
    }));
    console.log(`[backup] swept ${toDelete.length} old backup(s)`);
  }

  console.log('[backup] done');
}

// Run directly when invoked as a script.
if (import.meta.main) {
  const env = loadEnv();
  runBackup(env).catch((err) => {
    console.error('[backup] failed', err);
    process.exit(1);
  });
}
