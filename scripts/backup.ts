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

const PG_URL_PARAMETERS: Record<string, string> = {
  sslmode: 'PGSSLMODE',
  sslrootcert: 'PGSSLROOTCERT',
  sslcert: 'PGSSLCERT',
  sslkey: 'PGSSLKEY',
  connect_timeout: 'PGCONNECT_TIMEOUT',
  application_name: 'PGAPPNAME',
  options: 'PGOPTIONS',
  target_session_attrs: 'PGTARGETSESSIONATTRS',
  channel_binding: 'PGCHANNELBINDING',
  hostaddr: 'PGHOSTADDR',
};


/**
 * Convert a PostgreSQL URL into libpq environment variables. Keeping the
 * connection URL out of argv avoids exposing its password through process
 * listings. Only explicitly supported URL parameters are forwarded.
 */
export function pgDumpLaunchOptions(
  databaseUrl: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): { args: string[]; env: NodeJS.ProcessEnv } {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid PostgreSQL URL');
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use the PostgreSQL protocol');
  }

  let username: string;
  let password: string;
  let database: string;
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    throw new Error('DATABASE_URL contains malformed URL encoding');
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (!host || !username || !database) {
    throw new Error('DATABASE_URL must include a host, user, and database');
  }

  // Do not inherit S3/SMTP/app secrets or ambient libpq connection settings.
  // Use only process discovery/locale values plus parameters parsed above.
  const childEnv: NodeJS.ProcessEnv = {
    PATH: baseEnv.PATH ?? '/usr/bin:/bin',
    LANG: 'C',
    PGPASSFILE: '/dev/null',
  };
  childEnv.PGHOST = host;
  if (url.port) childEnv.PGPORT = url.port;
  childEnv.PGUSER = username;
  childEnv.PGPASSWORD = password;
  childEnv.PGDATABASE = database;

  const seenParameters = new Set<string>();
  for (const [name, value] of url.searchParams) {
    const envName = PG_URL_PARAMETERS[name];
    if (!envName) {
      throw new Error(`Unsupported DATABASE_URL connection parameter: ${name}`);
    }
    if (seenParameters.has(name)) {
      throw new Error(`Duplicate DATABASE_URL connection parameter: ${name}`);
    }
    seenParameters.add(name);
    childEnv[envName] = value;
  }

  return { args: ['--format=custom', '--no-password'], env: childEnv };
}

function redactPgDumpError(stderr: string, databaseUrl: string): string {
  let safe = stderr.split(databaseUrl).join('[redacted database URL]');
  try {
    const password = decodeURIComponent(new URL(databaseUrl).password);
    if (password) safe = safe.split(password).join('[redacted]');
  } catch {
    // The launch validation reports malformed URLs without including them.
  }
  return safe;
}

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
  const pgDumpOptions = pgDumpLaunchOptions(env.DATABASE_URL);
  const dumpProcess = spawn('pg_dump', pgDumpOptions.args, {
    env: pgDumpOptions.env,
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
        const stderr = redactPgDumpError(
          Buffer.concat(stderrChunks).toString(),
          env.DATABASE_URL,
        );
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
