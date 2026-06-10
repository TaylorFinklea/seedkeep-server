/**
 * Nightly pg_dump → S3 backup.
 *
 * Called from the worker's daily sentinel. Dumps the database in custom
 * format, compresses with gzip, uploads to the existing S3 bucket under
 * backups/seedkeep-YYYY-MM-DD.dump.gz. Sweeps objects older than 30 days.
 *
 * Requires pg_dump in PATH (added to the Dockerfile via postgresql client
 * package matching the Postgres major version).
 *
 * Self-hostable: relies only on DATABASE_URL + the same S3 env vars used
 * by the app. No Fly-specific APIs.
 *
 * Usage (called by worker, or manually):
 *   bun run scripts/backup.ts
 */

import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
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

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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

  // Wait for the dump process to complete and compress the output.
  const [compressedBuffer, exitCode] = await Promise.all([
    streamToBuffer(gzip as unknown as Readable),
    new Promise<number>((resolve) => {
      dumpProcess.on('close', resolve);
    }),
  ]);

  if (exitCode !== 0) {
    const stderr = Buffer.concat(stderrChunks).toString();
    throw new Error(`pg_dump exited with code ${exitCode}: ${stderr}`);
  }

  console.log(`[backup] dump complete (${compressedBuffer.byteLength} bytes compressed), uploading`);

  const s3 = getS3Client(env);
  await s3.send(new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    Body: compressedBuffer,
    ContentType: 'application/gzip',
  }));

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
