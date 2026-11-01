import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDir = join(process.cwd(), 'migrations');
const provisioningSql = readFileSync(
  join(process.cwd(), 'scripts/provision-runtime-role.sql'),
  'utf8',
);

describe('runtime role provisioning', () => {
  it('grants DML on each migrated application table, including worker state', () => {
    const tableNames = new Set<string>();
    for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'))) {
      const migration = readFileSync(join(migrationsDir, file), 'utf8');
      for (const match of migration.matchAll(
        /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi,
      )) {
        tableNames.add(match[1] ?? match[2]);
      }
    }

    for (const tableName of tableNames) {
      expect(provisioningSql).toContain(`"${tableName}"`);
    }
    expect(provisioningSql).toContain('"_seedkeep_kv"');
    expect(provisioningSql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE');
  });

  it('does not grant schema creation, ownership, or migration bookkeeping access', () => {
    expect(provisioningSql).not.toMatch(/GRANT\s+ALL|CREATE\s+SCHEMA|OWNER\s+TO|TRUNCATE/i);
    expect(provisioningSql).toContain('GRANT SELECT ON TABLE "_seedkeep_migrations" TO seedkeep_web_runtime');
    expect(provisioningSql).toContain('CREATE ROLE seedkeep_web_runtime');
    expect(provisioningSql).toContain('SELECT current_database() AS database_name');
    expect(provisioningSql).toContain('\\gset');
    expect(provisioningSql).toContain('NOBYPASSRLS');
    expect(provisioningSql).not.toMatch(/PASSWORD\s+['"]/i);
  });
});
