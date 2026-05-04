/**
 * Hand-rolled migration runner. Reads `migrations/*.sql` in lexicographic
 * order, applies each one inside a transaction, and records its name in
 * `_seedkeep_migrations(name, applied_at)`. Re-runs are idempotent.
 *
 * Run via `bun run migrate` or `bun run src/db/migrate.ts`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../env';
import { closeDb, getSql } from './client';

async function ensureMigrationTable(sql: ReturnType<typeof getSql>) {
  await sql`
    CREATE TABLE IF NOT EXISTS _seedkeep_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

async function appliedNames(sql: ReturnType<typeof getSql>): Promise<Set<string>> {
  const rows = await sql<{ name: string }[]>`
    SELECT name FROM _seedkeep_migrations
  `;
  return new Set(rows.map((r) => r.name));
}

function migrationFiles(): { name: string; path: string }[] {
  // `migrations/` is always at the repo root.
  const dir = join(process.cwd(), 'migrations');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, path: join(dir, name) }));
}

async function applyMigration(
  sql: ReturnType<typeof getSql>,
  name: string,
  body: string
): Promise<void> {
  // postgres.js can run multi-statement bodies via `unsafe()` and wraps
  // everything in a transaction when called inside `sql.begin()`. The DDL
  // we ship is idempotent enough (`CREATE TABLE IF NOT EXISTS` etc.) that
  // a partial failure leaves the DB in a recoverable state.
  await sql.begin(async (tx) => {
    await tx.unsafe(body);
    await tx`INSERT INTO _seedkeep_migrations (name) VALUES (${name})`;
  });
}

export async function migrate(): Promise<{ applied: string[] }> {
  const env = loadEnv();
  const sql = getSql(env);
  await ensureMigrationTable(sql);

  const already = await appliedNames(sql);
  const applied: string[] = [];

  for (const { name, path } of migrationFiles()) {
    if (already.has(name)) continue;
    const body = readFileSync(path, 'utf8');
    process.stdout.write(`→ applying ${name}… `);
    await applyMigration(sql, name, body);
    process.stdout.write('ok\n');
    applied.push(name);
  }

  if (applied.length === 0) {
    console.log('Nothing to apply.');
  } else {
    console.log(`Applied ${applied.length} migration(s).`);
  }
  return { applied };
}

// Run when invoked directly (Bun entrypoint).
if (import.meta.main) {
  migrate()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Migration failed:', err);
      closeDb().finally(() => process.exit(1));
    });
}
