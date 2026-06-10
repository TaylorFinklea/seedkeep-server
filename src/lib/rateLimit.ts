/**
 * Reusable per-user count-window rate limiter.
 *
 * Mirrors the pattern in src/routes/catalog.ts: counts rows in a table
 * created since a rolling window and returns a 429-shaped response when
 * the limit is exceeded.
 *
 * Usage:
 *   const result = await checkRateLimit(sql, {
 *     userId,
 *     table: 'seed_photos',
 *     createdAtColumn: 'captured_at',
 *     windowMs: 3_600_000,
 *     limit: 20,
 *     retryAfterSeconds: 3600,
 *   });
 *   if (result.limited) {
 *     return c.json(result.response, 429);
 *   }
 */

import type { Sql } from 'postgres';

export interface RateLimitOptions {
  /** The value to scope the count to (user id or household id). */
  scopeId: string;
  /** Column on the table that holds the scope id (default: 'user_id'). */
  scopeColumn?: string;
  /** Table containing the rows to count. */
  table: string;
  /** Column that holds the epoch-ms timestamp (default: 'created_at'). */
  createdAtColumn?: string;
  /** Rolling window in milliseconds. */
  windowMs: number;
  /** Maximum number of rows allowed in the window before returning 429. */
  limit: number;
  /** Value to put in retry_after_seconds of the 429 body. */
  retryAfterSeconds: number;
  /** Human-readable message in the 429 body. */
  message?: string;
}

export interface RateLimitResult {
  limited: false;
}

export interface RateLimitHit {
  limited: true;
  response: {
    ok: false;
    error: { code: 'rate_limited'; message: string };
    retry_after_seconds: number;
  };
}

/**
 * Check whether `userId` has exceeded the count-window limit. Returns
 * `{ limited: false }` when the request may proceed, or `{ limited: true,
 * response }` when the limit is exceeded (the caller returns `response` as
 * a 429).
 */
export async function checkRateLimit(
  sql: Sql,
  opts: RateLimitOptions,
): Promise<RateLimitResult | RateLimitHit> {
  const col = opts.createdAtColumn ?? 'created_at';
  const scopeCol = opts.scopeColumn ?? 'user_id';
  const windowStart = Date.now() - opts.windowMs;

  const rows = await sql.unsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM ${opts.table}
      WHERE ${scopeCol} = $1 AND ${col} > $2`,
    [opts.scopeId, windowStart] as never,
  );
  const count = Number(rows[0]?.n ?? 0);

  if (count >= opts.limit) {
    return {
      limited: true,
      response: {
        ok: false,
        error: {
          code: 'rate_limited',
          message: opts.message ?? `too many requests — try again in ${opts.retryAfterSeconds}s`,
        },
        retry_after_seconds: opts.retryAfterSeconds,
      },
    };
  }

  return { limited: false };
}
