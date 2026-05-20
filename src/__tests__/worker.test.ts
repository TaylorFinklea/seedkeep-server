/**
 * Worker drain-logic tests — exercises applyJobOutcome (DB writes) and
 * outcomeStatus (pure logic) against a local Postgres instance.
 *
 * Prerequisites: local Postgres running with migrations 0001–0008 applied.
 * The test inserts isolated rows keyed by random IDs and cleans up in
 * afterEach, so it is safe to run alongside other tests.
 */

import { describe, it, expect, afterEach } from 'vitest';
import postgres from 'postgres';
import { applyJobOutcome, outcomeStatus, type JobRow } from '../worker';
import type { Sql } from 'postgres';
import type { AiBaseline } from '../lib/recommendation/aiFallback';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://seedkeep:dev-only@localhost:5432/seedkeep';

// Shared connection for all tests in this file.
const sql: Sql = postgres(DATABASE_URL, {
  transform: { undefined: null },
  onnotice: () => { /* silence */ },
  types: {
    bigint: {
      to: 20,
      from: [20],
      serialize: (x: number | bigint) => String(x),
      parse: (x: string) => Number(x),
    },
  },
});

// IDs created during each test — cleaned up in afterEach.
let testCatalogId: string | null = null;
let testJobId: string | null = null;

function uid(): string {
  return `wtest-${Math.random().toString(36).slice(2, 12)}`;
}

async function insertCatalogSeed(id: string): Promise<void> {
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO catalog_seeds (id, common_name, status, created_at, updated_at)
     VALUES ($1, 'Worker Test Seed', 'published', $2, $2)`,
    [id, now],
  );
}

async function insertJob(id: string, catalogSeedId: string, attempts: number): Promise<void> {
  await sql.unsafe(
    `INSERT INTO recommendation_jobs
       (id, catalog_seed_id, location_signature, status, attempts, created_at)
     VALUES ($1, $2, 'test-zone:0.0,0.0', 'running', $3, $4)`,
    [id, catalogSeedId, attempts, Date.now()],
  );
}

afterEach(async () => {
  if (testJobId) {
    await sql.unsafe(`DELETE FROM recommendation_jobs WHERE id = $1`, [testJobId]);
    testJobId = null;
  }
  if (testCatalogId) {
    // CASCADE removes recommendation_cache rows too.
    await sql.unsafe(`DELETE FROM catalog_seeds WHERE id = $1`, [testCatalogId]);
    testCatalogId = null;
  }
});

// ── pure logic ────────────────────────────────────────────────────────────────

describe('outcomeStatus', () => {
  it('returns pending when attempts + 1 < maxAttempts', () => {
    expect(outcomeStatus(0, 3)).toBe('pending');
    expect(outcomeStatus(1, 3)).toBe('pending');
  });

  it('returns failed when attempts + 1 >= maxAttempts', () => {
    expect(outcomeStatus(2, 3)).toBe('failed');
    expect(outcomeStatus(3, 3)).toBe('failed');
  });
});

// ── DB-backed logic ───────────────────────────────────────────────────────────

describe('applyJobOutcome (against local Postgres)', () => {
  it('success: marks job done and writes cache row', async () => {
    testCatalogId = uid();
    testJobId = uid();
    await insertCatalogSeed(testCatalogId);
    await insertJob(testJobId, testCatalogId, 0);

    const job: JobRow = {
      id: testJobId,
      catalog_seed_id: testCatalogId,
      location_signature: 'test-zone:0.0,0.0',
      attempts: 0,
    };

    const ai: AiBaseline = {
      windowStart: '2026-05-01',
      windowEnd: '2026-07-31',
      indoorStart: null,
      indoorEnd: null,
      confidence: 0.85,
      reasoning: 'Good warm-season window.',
      source: 'ai',
    };

    await applyJobOutcome(sql, job, { ok: true, ai });

    const jobRow = await sql.unsafe<{ status: string }[]>(
      `SELECT status FROM recommendation_jobs WHERE id = $1`,
      [testJobId],
    );
    expect(jobRow[0]?.status).toBe('done');

    const cacheRow = await sql.unsafe<{ source: string; inputs_used: string }[]>(
      `SELECT source, inputs_used FROM recommendation_cache
        WHERE catalog_seed_id = $1 AND location_signature = $2`,
      [testCatalogId, 'test-zone:0.0,0.0'],
    );
    expect(cacheRow[0]?.source).toBe('ai');
    expect(JSON.parse(cacheRow[0]?.inputs_used ?? '[]')).toEqual(['ai_fallback']);
  });

  it('failure with attempts < MAX_ATTEMPTS: marks job pending with incremented attempts', async () => {
    testCatalogId = uid();
    testJobId = uid();
    await insertCatalogSeed(testCatalogId);
    await insertJob(testJobId, testCatalogId, 1); // attempts=1, MAX=3 → next attempt=2 → pending

    const job: JobRow = {
      id: testJobId,
      catalog_seed_id: testCatalogId,
      location_signature: 'test-zone:0.0,0.0',
      attempts: 1,
    };

    await applyJobOutcome(sql, job, { ok: false, err: new Error('transient network error') });

    const jobRow = await sql.unsafe<{ status: string; attempts: number; last_error: string }[]>(
      `SELECT status, attempts, last_error FROM recommendation_jobs WHERE id = $1`,
      [testJobId],
    );
    expect(jobRow[0]?.status).toBe('pending');
    expect(jobRow[0]?.attempts).toBe(2);
    expect(jobRow[0]?.last_error).toContain('transient network error');
  });

  it('failure with attempts reaching MAX_ATTEMPTS: marks job failed', async () => {
    testCatalogId = uid();
    testJobId = uid();
    await insertCatalogSeed(testCatalogId);
    await insertJob(testJobId, testCatalogId, 2); // attempts=2, MAX=3 → next attempt=3 → failed

    const job: JobRow = {
      id: testJobId,
      catalog_seed_id: testCatalogId,
      location_signature: 'test-zone:0.0,0.0',
      attempts: 2,
    };

    await applyJobOutcome(sql, job, { ok: false, err: new Error('persistent AI failure') });

    const jobRow = await sql.unsafe<{ status: string; attempts: number }[]>(
      `SELECT status, attempts FROM recommendation_jobs WHERE id = $1`,
      [testJobId],
    );
    expect(jobRow[0]?.status).toBe('failed');
    expect(jobRow[0]?.attempts).toBe(3);
  });
});
