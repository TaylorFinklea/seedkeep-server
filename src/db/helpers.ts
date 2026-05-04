import type { Sql } from 'postgres';

/**
 * Thin wrappers around `postgres.js`. The shape mirrors the helpers from
 * the Workers attempt (`dbGet/dbAll/dbRun/dbBatch`) so the route code
 * ports over with minimal edits.
 *
 * postgres.js uses tagged templates natively; these helpers accept a
 * pre-built SQL string + positional params for parity with the Workers
 * D1 prepared-statement style. For new code, prefer the tagged-template
 * form directly: `await sql\`SELECT ...\``.
 */

// postgres.js's `unsafe` is statically typed against the schema. We don't
// thread a schema through these helpers (they're a portability shim), so
// the parameter array is `any[]` at the boundary. The runtime values are
// validated by zod and the surrounding route logic.
type AnyParams = readonly unknown[];

export async function dbGet<T>(
  sql: Sql,
  query: string,
  params: AnyParams = []
): Promise<T | null> {
  const rows = await sql.unsafe<(T & Record<string, unknown>)[]>(query, params as never);
  return (rows[0] as T | undefined) ?? null;
}

export async function dbAll<T>(
  sql: Sql,
  query: string,
  params: AnyParams = []
): Promise<T[]> {
  const rows = await sql.unsafe<(T & Record<string, unknown>)[]>(query, params as never);
  return rows as T[];
}

/**
 * Run a write statement (INSERT / UPDATE / DELETE) and return the row
 * count. The Workers helper returned a `D1Result` with `.meta.changes`;
 * this returns an object shaped the same way so route code can be ported
 * verbatim.
 */
export async function dbRun(
  sql: Sql,
  query: string,
  params: AnyParams = []
): Promise<{ meta: { changes: number } }> {
  const result = await sql.unsafe(query, params as never);
  return { meta: { changes: result.count ?? 0 } };
}

/**
 * Run multiple statements inside a single transaction.  Mirrors the
 * Workers `dbBatch` shape so route code that batched writes ports over.
 */
export async function dbBatch(
  sql: Sql,
  statements: readonly { sql: string; params?: AnyParams }[]
): Promise<void> {
  await sql.begin(async (tx) => {
    for (const stmt of statements) {
      await tx.unsafe(stmt.sql, (stmt.params ?? []) as never);
    }
  });
}
