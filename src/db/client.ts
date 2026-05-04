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

let _sql: Sql | null = null;
let _kysely: Kysely<Record<string, never>> | null = null;

export function getSql(env: Env): Sql {
  if (_sql) return _sql;
  _sql = postgres(env.DATABASE_URL, {
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
    },
    onnotice: () => { /* silence Postgres NOTICE messages */ },
  });
  return _sql;
}

/**
 * Kysely instance over the same `postgres.js` connection. Used only by
 * better-auth's adapter; route handlers should prefer the raw helpers.
 *
 * Type parameter is the database schema. We pass `Record<string, never>`
 * because better-auth manages its own table types internally.
 */
export function getKysely(env: Env): Kysely<Record<string, never>> {
  if (_kysely) return _kysely;
  _kysely = new Kysely({
    dialect: new PostgresJSDialect({ postgres: getSql(env) }),
  });
  return _kysely;
}

/** Close pooled connections. Call from a SIGINT/SIGTERM handler. */
export async function closeDb(): Promise<void> {
  await _kysely?.destroy();
  await _sql?.end({ timeout: 5 });
  _kysely = null;
  _sql = null;
}
