/**
 * Web M1 Phase 3 · integration tests for migration 0030_web_integrity.sql.
 *
 * Locks the migration contract (.docs/ai/plans/web-m1-p3-integrity.md):
 *   - Re-runnable: applying the file a second time is a no-op, not an error.
 *   - The version and custom_type columns and the household-consistency
 *     constraints exist.
 *   - A composite foreign key rejects a cross-household reference for new rows.
 *   - Legacy cross-household rows leave that constraint NOT VALID (still
 *     enforced for new writes) instead of failing the migration.
 *
 * Applies the migration file through the same `sql.begin` + `unsafe` path
 * as `src/db/migrate.ts`. Run with:
 *
 *   bun test tests/integration/migration0030.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres, { type Sql } from 'postgres';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://seedkeep:dev-only@localhost:5432/seedkeep';

const MIGRATION = readFileSync(
  join(import.meta.dir, '../../migrations/0030_web_integrity.sql'),
  'utf8',
);

const sql: Sql = postgres(DATABASE_URL, {
  transform: { undefined: null },
  onnotice: () => { /* the migration raises NOTICE for legacy violators */ },
  types: {
    bigint: {
      to: 20,
      from: [20],
      serialize: (x: number | bigint) => String(x),
      parse: (x: string) => Number(x),
    },
  },
});

const UNIQUE_CONSTRAINTS = [
  'locations_id_household_uq',
  'tags_id_household_uq',
  'beds_id_household_uq',
  'seeds_id_household_uq',
  'planting_events_id_household_uq',
  'journal_entries_id_household_uq',
];

const FOREIGN_KEYS = [
  'seeds_location_household_fk',
  'seed_tags_tag_household_fk',
  'seed_tags_seed_household_fk',
  'planting_events_bed_household_fk',
  'planting_events_seed_household_fk',
  'journal_entries_seed_household_fk',
  'journal_entries_bed_household_fk',
  'journal_entries_event_household_fk',
  'journal_entry_photos_entry_household_fk',
  'seed_photos_seed_household_fk',
];

const cleanup = new Set<string>();

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 12)}`;
}

async function applyMigration(): Promise<void> {
  // Same shape as src/db/migrate.ts: the body runs inside one transaction.
  await sql.begin(async (tx) => {
    await tx.unsafe(MIGRATION);
  });
}

async function makeHousehold(): Promise<string> {
  const id = uid('mig-hh');
  await sql.unsafe(
    `INSERT INTO households (id, name, created_at, updated_at)
     VALUES ($1, 'Migration Household', $2, $2)`,
    [id, Date.now()],
  );
  cleanup.add(id);
  return id;
}

async function makeLocation(householdId: string): Promise<string> {
  const id = uid('mig-loc');
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO locations (id, household_id, name, created_at, updated_at)
     VALUES ($1, $2, 'Shed', $3, $3)`,
    [id, householdId, now],
  );
  return id;
}

async function constraintRow(
  name: string,
): Promise<{ contype: string; convalidated: boolean } | null> {
  const rows = await sql.unsafe<{ contype: string; convalidated: boolean }[]>(
    `SELECT contype, convalidated FROM pg_constraint WHERE conname = $1`,
    [name],
  );
  return rows[0] ?? null;
}

beforeAll(async () => {
  await sql`SELECT 1`;
});

afterAll(async () => {
  for (const id of cleanup) {
    await sql.unsafe(`DELETE FROM households WHERE id = $1`, [id]).catch(() => {});
  }
  await sql.end({ timeout: 5 });
});

describe('migration 0030 — re-runnable', () => {
  it('applying the migration twice succeeds and leaves the schema unchanged', async () => {
    await applyMigration();
    await applyMigration();
    const rows = await sql.unsafe<{ n: number }[]>(
      `SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname = ANY($1)`,
      [[...UNIQUE_CONSTRAINTS, ...FOREIGN_KEYS]],
    );
    expect(rows[0]!.n).toBe(UNIQUE_CONSTRAINTS.length + FOREIGN_KEYS.length);
  });
});

describe('migration 0030 — schema', () => {
  it('adds version to the mutable garden tables and custom_type to seeds', async () => {
    const columns = await sql.unsafe<{ table_name: string; column_name: string; column_default: string | null }[]>(
      `SELECT table_name, column_name, column_default
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND column_name IN ('version', 'custom_type')`,
    );
    const versionTables = columns
      .filter((c) => c.column_name === 'version')
      .map((c) => c.table_name)
      .sort();
    expect(versionTables).toEqual([
      'beds',
      'journal_checklist_items',
      'journal_entries',
      'locations',
      'planting_events',
      'seeds',
      'tags',
    ]);
    for (const c of columns.filter((c) => c.column_name === 'version')) {
      expect(c.column_default).toContain('1');
    }
    expect(columns.some((c) => c.table_name === 'seeds' && c.column_name === 'custom_type')).toBe(true);
  });

  it('creates every household-consistency unique and composite foreign key constraint', async () => {
    for (const name of UNIQUE_CONSTRAINTS) {
      const row = await constraintRow(name);
      expect(row?.contype).toBe('u');
    }
    for (const name of FOREIGN_KEYS) {
      const row = await constraintRow(name);
      expect(row?.contype).toBe('f');
    }
  });
});

describe('migration 0030 — composite foreign keys', () => {
  it('rejects a seed in one household that references a location in another (new rows)', async () => {
    const hhA = await makeHousehold();
    const hhB = await makeHousehold();
    const locA = await makeLocation(hhA);

    const seedId = uid('mig-seed');
    let caught: { code?: string } | null = null;
    try {
      await sql.unsafe(
        `INSERT INTO seeds (id, household_id, state, location_id, created_at, updated_at)
         VALUES ($1, $2, 'active', $3, $4, $4)`,
        [seedId, hhB, locA, Date.now()],
      );
    } catch (err) {
      caught = err as { code?: string };
    }
    expect(caught?.code).toBe('23503');
  });

  it('rejects a seed_tags row that pairs a tag from another household', async () => {
    const hhA = await makeHousehold();
    const hhB = await makeHousehold();
    const now = Date.now();
    const tagA = uid('mig-tag');
    const seedB = uid('mig-seed');
    await sql.unsafe(
      `INSERT INTO tags (id, household_id, name, created_at, updated_at) VALUES ($1, $2, 'Organic', $3, $3)`,
      [tagA, hhA, now],
    );
    await sql.unsafe(
      `INSERT INTO seeds (id, household_id, state, created_at, updated_at) VALUES ($1, $2, 'active', $3, $3)`,
      [seedB, hhB, now],
    );
    let caught: { code?: string } | null = null;
    try {
      await sql.unsafe(
        `INSERT INTO seed_tags (seed_id, tag_id, household_id) VALUES ($1, $2, $3)`,
        [seedB, tagA, hhB],
      );
    } catch (err) {
      caught = err as { code?: string };
    }
    expect(caught?.code).toBe('23503');
  });

  it('still accepts a same-household reference and a NULL location', async () => {
    const hh = await makeHousehold();
    const loc = await makeLocation(hh);
    const now = Date.now();
    await sql.unsafe(
      `INSERT INTO seeds (id, household_id, state, location_id, created_at, updated_at)
       VALUES ($1, $2, 'active', $3, $4, $4), ($5, $2, 'active', NULL, $4, $4)`,
      [uid('mig-seed'), hh, loc, now, uid('mig-seed')],
    );
    const rows = await sql.unsafe<{ n: number }[]>(
      `SELECT COUNT(*)::int AS n FROM seeds WHERE household_id = $1`,
      [hh],
    );
    expect(rows[0]!.n).toBe(2);
  });
});

describe('migration 0030 — legacy cross-household rows', () => {
  it('leaves a constraint NOT VALID when legacy rows violate it, and still enforces new writes', async () => {
    const hhA = await makeHousehold();
    const hhB = await makeHousehold();
    const locA = await makeLocation(hhA);
    const legacySeed = uid('mig-legacy');
    const name = 'seeds_location_household_fk';
    try {
      // Simulate a pre-migration database: the constraint is absent and a
      // cross-household row exists.
      await sql.unsafe(`ALTER TABLE seeds DROP CONSTRAINT IF EXISTS ${name}`);
      await sql.unsafe(
        `INSERT INTO seeds (id, household_id, state, location_id, created_at, updated_at)
         VALUES ($1, $2, 'active', $3, $4, $4)`,
        [legacySeed, hhB, locA, Date.now()],
      );

      // Re-running the migration must not fail on the legacy row.
      await applyMigration();

      const row = await constraintRow(name);
      expect(row?.contype).toBe('f');
      expect(row?.convalidated).toBe(false);

      let caught: { code?: string } | null = null;
      try {
        await sql.unsafe(
          `INSERT INTO seeds (id, household_id, state, location_id, created_at, updated_at)
           VALUES ($1, $2, 'active', $3, $4, $4)`,
          [uid('mig-new'), hhB, locA, Date.now()],
        );
      } catch (err) {
        caught = err as { code?: string };
      }
      expect(caught?.code).toBe('23503');
    } finally {
      // Restore a validated state: drop the legacy row, then re-apply.
      await sql.unsafe(`DELETE FROM seeds WHERE id = $1`, [legacySeed]);
      await applyMigration();
      const restored = await constraintRow(name);
      expect(restored?.convalidated).toBe(true);
    }
  });
});
