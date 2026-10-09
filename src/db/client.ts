import postgres, { type Sql } from 'postgres';
import { Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import type { Env } from '../env';

/**
 * Single shared `postgres.js` connection. Used directly by route handlers
 * via the helpers in `db/helpers.ts`, and wrapped by Kysely below for the
 * better-auth adapter (which requires a Kysely instance).
 *
 * Connection lifecycle: created once at module import, closed on process
 * exit. Bun's `Bun.serve` doesn't call any teardown hook so we register a
 * signal handler.
 */

const sqlByDatabaseURL = new Map<string, Sql>();
const kyselyByDatabaseURL = new Map<string, Kysely<Record<string, never>>>();
const otpLockSqlByDatabaseURL = new Map<string, Sql>();

export function getSql(env: Env): Sql {
  const existing = sqlByDatabaseURL.get(env.DATABASE_URL);
  if (existing) return existing;
  const sql = postgres(env.DATABASE_URL, {
    max: 10,
    // postgres.js defaults to camelCase column transform — disable so our
    // snake_case schema deserializes literally.
    transform: { undefined: null },
    types: {
      // BIGINT (OID 20) holds ms-epoch timestamps (< 2^53 always). Parse as
      // JS Number so the JSON wire format matches the iOS client's Int64.
      // Without this override, postgres.js returns strings to avoid lossy
      // conversion of arbitrary BIGINT values.
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: number | bigint) => String(x),
        parse: (x: string) => Number(x),
      },
      // NUMERIC (OID 1700) — postgres.js returns strings by default to
      // preserve precision. Our NUMERIC columns are bounded physical
      // measurements (e.g. seed_depth_inches NUMERIC(3,2), bed/event
      // *_feet NUMERIC(5,2)) that fit comfortably in f64. Parse as Number
      // so the JSON wire format matches the iOS client's Double.
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (x: number) => String(x),
        parse: (x: string) => Number(x),
      },
    },
    onnotice: () => { /* silence Postgres NOTICE messages */ },
  });
  sqlByDatabaseURL.set(env.DATABASE_URL, sql);
  return sql;
}

/** Separate, small pool for session-level OTP advisory locks. */
export function getOTPLockSql(env: Env): Sql {
  const existing = otpLockSqlByDatabaseURL.get(env.DATABASE_URL);
  if (existing) return existing;
  const sql = postgres(env.DATABASE_URL, {
    max: 5,
    connect_timeout: 3,
    transform: { undefined: null },
    onnotice: () => { /* silence Postgres NOTICE messages */ },
  });
  otpLockSqlByDatabaseURL.set(env.DATABASE_URL, sql);
  return sql;
}

/**
 * Kysely instance over the same `postgres.js` connection. Used only by
 * better-auth's adapter; route handlers should prefer the raw helpers.
 *
 * Type parameter is the database schema. We pass `Record<string, never>`
 * because better-auth manages its own table types internally.
 */
export function getKysely(env: Env): Kysely<Record<string, never>> {
  const existing = kyselyByDatabaseURL.get(env.DATABASE_URL);
  if (existing) return existing;
  const kysely = new Kysely<Record<string, never>>({
    dialect: new PostgresJSDialect({ postgres: getSql(env) }),
  });
  kyselyByDatabaseURL.set(env.DATABASE_URL, kysely);
  return kysely;
}

/** Close pooled connections. Call from a SIGINT/SIGTERM handler. */
export async function closeDb(): Promise<void> {
  await Promise.all([...kyselyByDatabaseURL.values()].map((kysely) => kysely.destroy()));
  await Promise.all([...sqlByDatabaseURL.values()].map((sql) => sql.end({ timeout: 5 })));
  await Promise.all([...otpLockSqlByDatabaseURL.values()].map((sql) => sql.end({ timeout: 5 })));
  kyselyByDatabaseURL.clear();
  sqlByDatabaseURL.clear();
  otpLockSqlByDatabaseURL.clear();
}
