// Standalone worker process: drains two AI-backed job sources in a single
// always-on Bun loop. Run with `bun run worker`. Deployed as a separate
// Fly process so the web process stays stateless.
//
// Job sources, in order per tick:
//   1. recommendation_jobs  — AI baseline for low-confidence planting windows.
//   2. catalog_feedback     — Phase 4D moderation worker, drains structured
//                             corrections for catalog_seeds.
//
// Each path is wrapped in its own try/catch; a throw in one cannot crash
// the other tick. After processOneCorrection returns false (queue empty),
// we sleep POLL_INTERVAL_MS before the next iteration.

import { loadEnv } from './env';
import { getSql, closeDb } from './db/client';
import { dbGet, dbRun } from './db/helpers';
import type { Sql } from 'postgres';
import { fetchAiBaseline } from './lib/recommendation/aiFallback';
import type { AiBaseline } from './lib/recommendation/aiFallback';
import type { HouseholdLocation } from './lib/recommendation/engine';
import { processOne as processOneCorrection } from './lib/catalog/moderationWorker';

const POLL_INTERVAL_MS = 5_000;
const MAX_ATTEMPTS = 3;
const JOB_REAPER_TIMEOUT_MS = 10 * 60_000; // match corrections worker
const FETCH_AI_TIMEOUT_MS = 60_000;

export interface JobRow {
  id: string;
  catalog_seed_id: string;
  location_signature: string;
  attempts: number;
  started_at: number | null;
}

interface CatalogRow {
  common_name: string;
  variety: string | null;
  instructions: string | null;
}

// location_signature is "<zone>:<lat>,<lon>". Recover the engine inputs.
function parseSignature(sig: string): { zone: string; lat: number; lon: number } {
  const [zone, coords] = sig.split(':');
  const [lat, lon] = coords.split(',').map(Number);
  return { zone, lat, lon };
}

/**
 * Reset recommendation_jobs rows stuck in 'running' for longer than
 * JOB_REAPER_TIMEOUT_MS. Mirrors reapOrphanedClaims in the corrections worker.
 * Returns the number of rows reaped.
 */
export async function reapStrandedJobs(sql: Sql, now: number = Date.now()): Promise<number> {
  const cutoff = now - JOB_REAPER_TIMEOUT_MS;
  const result = await sql.unsafe(
    `UPDATE recommendation_jobs
        SET status = 'pending', started_at = NULL
      WHERE status = 'running' AND started_at IS NOT NULL AND started_at < $1`,
    [cutoff],
  );
  return Number((result as { count?: number }).count ?? 0);
}

// Exported for unit-testing: applies the outcome of a completed (or failed)
// AI call back to the database. Pure-ish — takes an injectable sql handle so
// tests can pass a real tx or a fake.
export async function applyJobOutcome(
  sql: Sql,
  job: JobRow,
  result: { ok: true; ai: AiBaseline } | { ok: false; err: unknown },
): Promise<void> {
  if (result.ok) {
    const { ai } = result;
    await dbRun(
      sql,
      `INSERT INTO recommendation_cache
         (catalog_seed_id, location_signature, computed_at, source, confidence,
          window_start, window_end, indoor_start, indoor_end, reasoning, inputs_used)
       VALUES ($1,$2,$3,'ai',$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (catalog_seed_id, location_signature) DO UPDATE SET
         computed_at = EXCLUDED.computed_at, source = 'ai',
         confidence = EXCLUDED.confidence, window_start = EXCLUDED.window_start,
         window_end = EXCLUDED.window_end, indoor_start = EXCLUDED.indoor_start,
         indoor_end = EXCLUDED.indoor_end, reasoning = EXCLUDED.reasoning,
         inputs_used = EXCLUDED.inputs_used`,
      [job.catalog_seed_id, job.location_signature, Date.now(), ai.confidence,
       ai.windowStart, ai.windowEnd, ai.indoorStart, ai.indoorEnd,
       ai.reasoning, JSON.stringify(['ai_fallback'])],
    );
    await dbRun(sql, `UPDATE recommendation_jobs SET status = 'done' WHERE id = $1`, [job.id]);
  } else {
    const attempts = job.attempts + 1;
    const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    await dbRun(
      sql,
      `UPDATE recommendation_jobs SET status = $1, attempts = $2, last_error = $3 WHERE id = $4`,
      [status, attempts, String(result.err), job.id],
    );
  }
}

// Exported for unit-testing: the pure decision of what status results from an
// error given the current attempt count. No I/O.
export function outcomeStatus(attempts: number, maxAttempts: number): 'pending' | 'failed' {
  return attempts + 1 >= maxAttempts ? 'failed' : 'pending';
}

async function processOne(env: ReturnType<typeof loadEnv>): Promise<boolean> {
  const sql = getSql(env);
  const now = Date.now();

  // Reap recommendation_jobs stuck in 'running' for > 10 min. Mirrors
  // reapOrphanedClaims in the corrections worker.
  try {
    await reapStrandedJobs(sql, now);
  } catch (err) {
    console.error('[worker] recommendation reaper error', err);
  }

  // Claim a job atomically: the SELECT ... FOR UPDATE SKIP LOCKED and the
  // status='running' UPDATE must be in the same transaction so the row lock
  // is held across both statements. Without a transaction the lock releases
  // immediately after the SELECT and two workers can claim the same job.
  // Stamp started_at so the reaper can detect rows that never finish.
  const job = await sql.begin(async (tx) => {
    const rows = await tx.unsafe<JobRow[]>(
      `SELECT id, catalog_seed_id, location_signature, attempts, started_at
         FROM recommendation_jobs
        WHERE status = 'pending'
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [],
    );
    const claimed = rows[0] as JobRow | undefined;
    if (!claimed) return null;
    await tx.unsafe(
      `UPDATE recommendation_jobs SET status = 'running', started_at = $2 WHERE id = $1`,
      [claimed.id, now],
    );
    return claimed;
  });

  if (!job) return false;

  let result: { ok: true; ai: AiBaseline } | { ok: false; err: unknown };
  try {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

    const cat = await dbGet<CatalogRow>(
      sql, `SELECT common_name, variety, instructions FROM catalog_seeds WHERE id = $1 LIMIT 1`,
      [job.catalog_seed_id],
    );
    if (!cat) throw new Error('catalog seed gone');

    // Resolve frost dates from the job's own location signature (lat/lon),
    // not an arbitrary household in the same zone. The signature is
    // "<zone>:<lat>,<lon>"; find the household whose stored coordinates
    // round-trip back to the same signature so the worker and route agree.
    const { zone, lat, lon } = parseSignature(job.location_signature);
    const frost = await dbGet<{ avg_last_frost: string; avg_first_frost: string }>(
      sql,
      `SELECT avg_last_frost, avg_first_frost FROM households
        WHERE usda_zone = $1
          AND ROUND(latitude::numeric, 4) = ROUND($2::numeric, 4)
          AND ROUND(longitude::numeric, 4) = ROUND($3::numeric, 4)
          AND avg_last_frost IS NOT NULL
        LIMIT 1`,
      [zone, lat, lon],
    );
    if (!frost) throw new Error('no frost data for location');

    const loc: HouseholdLocation = {
      usdaZone: zone, avgLastFrost: frost.avg_last_frost, avgFirstFrost: frost.avg_first_frost,
    };
    const year = new Date().getUTCFullYear();
    const ai = await fetchAiBaseline(apiKey, env.DEFAULT_REVIEW_MODEL,
      { commonName: cat.common_name, variety: cat.variety, instructions: cat.instructions },
      loc, year,
      FETCH_AI_TIMEOUT_MS,
    );
    if (!ai) throw new Error('AI returned no usable baseline');
    result = { ok: true, ai };
  } catch (err) {
    result = { ok: false, err };
  }

  await applyJobOutcome(sql, job, result);
  return true;
}

const WORKER_HEARTBEAT_KEY = 'worker_last_tick';

async function upsertHeartbeat(sql: Sql): Promise<void> {
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS _seedkeep_kv (k TEXT PRIMARY KEY, v TEXT)`,
  );
  await sql.unsafe(
    `INSERT INTO _seedkeep_kv (k, v) VALUES ($1, $2)
     ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [WORKER_HEARTBEAT_KEY, String(Date.now())],
  );
}

async function main() {
  const env = loadEnv();
  console.log('[worker] recommendation fill-in worker started');
  let running = true;
  process.on('SIGTERM', () => { running = false; });
  process.on('SIGINT', () => { running = false; });

  while (running) {
    // Heartbeat: upsert worker_last_tick once per loop iteration so the
    // health-check / ops floor can detect a wedged worker.
    try {
      const sql = getSql(env);
      await upsertHeartbeat(sql);
    } catch (err) {
      console.error('[worker] heartbeat error', err);
    }

    // Check SIGTERM between jobs — in-flight await finishes, no new claims.
    if (!running) break;

    let didWork = false;
    try {
      didWork = await processOne(env);
    } catch (err) {
      console.error('[worker] recommendation poll error', err);
    }
    // Phase 4D — catalog corrections piggyback. Independent try/catch:
    // a throw here cannot mask or crash the recommendation path's tick.
    if (running && !didWork) {
      try {
        const sql = getSql(env);
        didWork = await processOneCorrection(env, sql);
      } catch (err) {
        console.error('[worker] corrections poll error', err);
      }
    }
    if (!didWork) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  await closeDb();
  console.log('[worker] stopped');
}

// Only start the polling loop when executed directly (not when imported by tests).
if (import.meta.main) {
  void main();
}
