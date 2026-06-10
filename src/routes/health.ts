import { Hono } from 'hono';
import type { AppEnv } from '../index';
import { getSql } from '../db/client';

export const healthRoutes = new Hono<AppEnv>();

const WORKER_STALE_MS = 2 * 60 * 1000; // 2 minutes

healthRoutes.get('/health', async (c) => {
  const sql = getSql(c.env);

  // Always run SELECT 1 — if the DB is down this throws and the envelope
  // returns 500, which Fly's health check treats as unhealthy.
  await sql.unsafe('SELECT 1');

  // Worker heartbeat lag from _seedkeep_kv. Missing key → worker never
  // started (newly deployed); stale → worker may be wedged. Both cases
  // return HTTP 200 so a temporarily-missing worker doesn't take the web
  // process down; ops monitors the stale flag separately.
  let workerLastTick: number | null = null;
  let workerStale = false;
  try {
    const row = await sql.unsafe<{ v: string }[]>(
      `SELECT v FROM _seedkeep_kv WHERE k = 'worker_last_tick' LIMIT 1`,
    );
    if (row[0]) {
      workerLastTick = Number(row[0].v);
      workerStale = Date.now() - workerLastTick > WORKER_STALE_MS;
    }
  } catch {
    // _seedkeep_kv may not exist in fresh deploys — treat as missing, not error.
  }

  return c.json({
    ok: true,
    data: {
      status: 'healthy',
      env: c.env.APP_ENV,
      worker_last_tick: workerLastTick,
      worker_stale: workerStale,
    },
  });
});
