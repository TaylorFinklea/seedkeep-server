/**
 * Unit tests for scripts/backup.ts streaming upload.
 *
 * These tests inject mock S3 clients / Upload constructors and do NOT require
 * a live database or S3 endpoint. They verify:
 *
 *   1. The Upload Body passed to S3 is a Readable stream (never a Buffer).
 *   2. A pg_dump spawn error (ENOENT) causes runBackup() to reject.
 *
 * End-to-end rehearse (local MinIO + docker-compose Postgres) is a manual
 * step — see the header comment in scripts/backup.ts for exact commands.
 * The minio service in docker-compose.yml exposes port 9000 (S3 API) and
 * the db service exposes Postgres on port 5432.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// ── per-test control refs (mutated in beforeEach) ────────────────────────
// Mutable refs captured by the vi.mock factories below so each test can
// swap behaviour without re-registering mocks.
let spawnImpl: () => ReturnType<typeof makeFakeChild> = () => makeFakeChild(0);
let uploadDoneImpl: () => Promise<void> = () =>
  new Promise<void>((r) => setImmediate(r));

let capturedUploadBody: unknown = null;
let capturedSpawnCall: { command: string; args: string[]; env: NodeJS.ProcessEnv | undefined } | null = null;

// ── helpers ────────────────────────────────────────────────────────────────

/** Build a fake ChildProcess that closes cleanly or emits an error. */
function makeFakeChild(exitCode: number, emitError?: Error) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const fake = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: null,
    pid: 99999,
    exitCode: null as number | null,
    signalCode: null,
    killed: false,
  });

  setImmediate(() => {
    if (emitError) {
      // Only emit on the process — do NOT destroy stdout (which is piped into
      // gzip). Destroying it triggers an unhandled 'error' event on the gzip
      // stream after runBackup() has already rejected, causing a test-runner
      // unhandled-error report. The process 'error' event is sufficient to
      // reject the spawnErrorPromise inside runBackup().
      fake.emit('error', emitError);
    } else {
      stdout.end();
      fake.emit('close', exitCode);
    }
  });

  return fake;
}

// ── hoisted mocks ──────────────────────────────────────────────────────────
// vi.mock calls are hoisted to the top of the file by vitest. The factory
// captures the mutable refs declared above so per-test beforeEach() swaps
// drive the behavior — this is the standard vitest pattern for per-test
// mock configuration with hoisted mocks.

vi.mock('node:child_process', () => ({
  spawn: (...args: Parameters<typeof import('node:child_process').spawn>) => {
    const [command, commandArgs, options] = args;
    capturedSpawnCall = {
      command: String(command),
      args: [...commandArgs],
      env: options?.env as NodeJS.ProcessEnv | undefined,
    };
    return spawnImpl();
  },
}));

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: vi.fn().mockImplementation((opts: { params: { Body: unknown } }) => {
    capturedUploadBody = opts.params.Body;
    return { done: () => uploadDoneImpl() };
  }),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ Contents: [] }),
  })),
  ListObjectsV2Command: vi.fn(),
  DeleteObjectsCommand: vi.fn(),
}));

// ── env fixture ────────────────────────────────────────────────────────────
const stubEnv = {
  DATABASE_URL: 'postgres://seedkeep:dev-only@localhost:5432/seedkeep',
  S3_REGION: 'us-east-1',
  S3_ENDPOINT: undefined,
  S3_ACCESS_KEY_ID: 'test-key',
  S3_SECRET_ACCESS_KEY: 'test-secret',
  S3_BUCKET: 'test-bucket',
  S3_FORCE_PATH_STYLE: false,
  APP_ENV: 'development' as const,
  PORT: 8787,
  BETTER_AUTH_SECRET: 'a-sufficiently-long-test-secret-here',
  APPLE_CLIENT_ID: 'client',
  APPLE_CLIENT_SECRET: 'secret',
  DEFAULT_VISION_MODEL: 'claude-sonnet-4-6',
  DEFAULT_REVIEW_MODEL: 'claude-haiku-4-5-20251001',
  ANTHROPIC_API_KEY: undefined,
  APPLE_IAP_SHARED_SECRET: undefined,
  ASSISTANT_KEY_MASTER: undefined,
  ADMIN_SECRET: undefined,
} as ReturnType<typeof import('../env').loadEnv>;

beforeEach(() => {
  capturedUploadBody = null;
  capturedSpawnCall = null;
  // Default: clean pg_dump, Upload resolves immediately.
  spawnImpl = () => makeFakeChild(0);
  uploadDoneImpl = () => new Promise<void>((r) => setImmediate(r));
});

// ── tests ──────────────────────────────────────────────────────────────────

describe('runBackup — streaming upload', () => {
  it('passes a Readable stream (not a Buffer) as Upload Body', async () => {
    // Use defaults: clean exit, upload resolves immediately.
    const { runBackup } = await import('../../scripts/backup');

    // pg_dump closes with exit 0, Upload resolves — full success path.
    await runBackup(stubEnv);

    expect(capturedUploadBody).not.toBeNull();
    expect(capturedUploadBody).not.toBeInstanceOf(Buffer);
    expect(capturedUploadBody).not.toBeInstanceOf(Uint8Array);

    const isReadable =
      capturedUploadBody instanceof Readable ||
      (
        typeof capturedUploadBody === 'object' &&
        capturedUploadBody !== null &&
        typeof (capturedUploadBody as { pipe?: unknown }).pipe === 'function'
      );
    expect(isReadable).toBe(true);
  });
});

describe('runBackup — PostgreSQL credential handling', () => {
  it('keeps the connection URL out of pg_dump argv and passes libpq settings through env', async () => {
    const syntheticUrl = 'postgresql://seedkeep:synthetic-only-pass@db.example:5432/seedkeep?sslmode=require&channel_binding=require&hostaddr=192.0.2.10';
    const { runBackup } = await import('../../scripts/backup');

    await runBackup({ ...stubEnv, DATABASE_URL: syntheticUrl });

    expect(capturedSpawnCall?.command).toBe('pg_dump');
    expect(capturedSpawnCall?.args).toEqual(['--format=custom', '--no-password']);
    expect(capturedSpawnCall?.args.join(' ')).not.toContain('synthetic-only-pass');
    expect(capturedSpawnCall?.args.join(' ')).not.toContain(syntheticUrl);
    expect(capturedSpawnCall?.env?.DATABASE_URL).toBeUndefined();
    expect(capturedSpawnCall?.env?.PGHOST).toBe('db.example');
    expect(capturedSpawnCall?.env?.PGPORT).toBe('5432');
    expect(capturedSpawnCall?.env?.PGUSER).toBe('seedkeep');
    expect(capturedSpawnCall?.env?.PGPASSWORD).toBe('synthetic-only-pass');
    expect(capturedSpawnCall?.env?.PGDATABASE).toBe('seedkeep');
    expect(capturedSpawnCall?.env?.PGSSLMODE).toBe('require');
    expect(capturedSpawnCall?.env?.PGCHANNELBINDING).toBe('require');
    expect(capturedSpawnCall?.env?.PGHOSTADDR).toBe('192.0.2.10');
    expect(capturedSpawnCall?.env?.PGPASSFILE).toBe('/dev/null');
  });

  it('does not inherit unrelated secrets or ambient libpq connection settings', async () => {
    const { pgDumpLaunchOptions } = await import('../../scripts/backup');
    const options = pgDumpLaunchOptions(
      'postgres://seedkeep:synthetic-only-pass@db.example/seedkeep',
      {
        PATH: '/custom/bin',
        AWS_SECRET_ACCESS_KEY: 'synthetic-aws-only',
        SMTP_PASSWORD: 'synthetic-mail-only',
        PGHOSTADDR: '192.0.2.99',
        PGSSLMODE: 'disable',
        PGOPTIONS: '-c search_path=public',
      },
    );

    expect(options.env.PATH).toBe('/custom/bin');
    expect(options.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(options.env.SMTP_PASSWORD).toBeUndefined();
    expect(options.env.PGHOSTADDR).toBeUndefined();
    expect(options.env.PGSSLMODE).toBeUndefined();
    expect(options.env.PGOPTIONS).toBeUndefined();
  });

  it('fails closed on unsupported connection URL parameters', async () => {
    const { pgDumpLaunchOptions } = await import('../../scripts/backup');

    expect(() => pgDumpLaunchOptions(
      'postgres://seedkeep:synthetic-only-pass@db.example/seedkeep?unexpected=1',
      {},
    )).toThrow('Unsupported DATABASE_URL connection parameter: unexpected');
  });
});

describe('runBackup — spawn error handling', () => {
  it('rejects when pg_dump binary does not exist (ENOENT)', async () => {
    const enoentError = Object.assign(new Error('spawn pg_dump ENOENT'), { code: 'ENOENT' });

    // Make spawn emit an error; make Upload.done() never resolve so the
    // error path wins the Promise.race.
    spawnImpl = () => makeFakeChild(0, enoentError);
    uploadDoneImpl = () => new Promise<void>(() => {});

    const { runBackup } = await import('../../scripts/backup');

    await expect(runBackup(stubEnv)).rejects.toThrow(/ENOENT|spawn/i);
  });
});
