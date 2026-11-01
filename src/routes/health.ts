import { Hono } from 'hono';
import type { AppEnv } from '../index';
import { getSql } from '../db/client';

export const healthRoutes = new Hono<AppEnv>();

const WORKER_STALE_MS = 2 * 60 * 1000; // 2 minutes
// A backup not recorded within 36 hours is considered stale (covers daily
// cadence + a full day of slack for the first backup after a fresh deploy).
const BACKUP_STALE_HOURS = 36;

healthRoutes.get('/health', async (c) => {
  const sql = getSql(c.env);

  // Always run SELECT 1 — if the DB is down this throws and the envelope
  // returns 500, which Fly's health check treats as unhealthy.
  await sql.unsafe('SELECT 1');

  // Worker heartbeat lag from _seedkeep_kv. Missing key → worker never
  // started (newly deployed); stale → worker may be wedged. Both cases
  // return HTTP 200 so a temporarily-missing worker doesn't take the web
  // process down; ops monitors the stale flag separately. The table itself is
  // required by migration 0030, so missing permissions or an unapplied
  // migration must fail readiness.
  let workerLastTick: number | null = null;
  let workerStale = false;
  let backupLastSuccessYmd: string | null = null;
  let backupStale = false;
  try {
    const rows = await sql.unsafe<{ k: string; v: string }[]>(
      `SELECT k, v FROM _seedkeep_kv
        WHERE k IN ('worker_last_tick', 'backup_last_success_ymd')`,
    );
    for (const row of rows) {
      if (row.k === 'worker_last_tick') {
        workerLastTick = Number(row.v);
        workerStale = Date.now() - workerLastTick > WORKER_STALE_MS;
      } else if (row.k === 'backup_last_success_ymd') {
        backupLastSuccessYmd = row.v;
        // Parse YYYY-MM-DD as UTC midnight, compare to now.
        const successTs = Date.parse(`${row.v}T00:00:00Z`);
        backupStale = Date.now() - successTs > BACKUP_STALE_HOURS * 60 * 60 * 1000;
      }
    }
    // No row for backup_last_success_ymd → never succeeded → stale.
    if (backupLastSuccessYmd === null) backupStale = true;
  } catch {
    // A missing table or insufficient runtime-role grant makes the API
    // unready. Keep database diagnostics out of the public health response.
    return c.json({
      ok: false,
      error: {
        code: 'worker_state_unavailable',
        message: 'Required worker state is unavailable',
      },
    }, 503);
  }

  return c.json({
    ok: true,
    data: {
      status: 'healthy',
      env: c.env.APP_ENV,
      worker_last_tick: workerLastTick,
      worker_stale: workerStale,
      backup_last_success_ymd: backupLastSuccessYmd,
      backup_stale: backupStale,
    },
  });
});
