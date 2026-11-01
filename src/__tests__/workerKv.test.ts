import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { upsertHeartbeat } from '../worker';

describe('worker key/value schema', () => {
  it('provisions the existing key/value shape in migration 0030', () => {
    const migration = readFileSync(
      join(process.cwd(), 'migrations/0030_worker_state_kv.sql'),
      'utf8',
    );

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS _seedkeep_kv');
    expect(migration).toContain('k TEXT PRIMARY KEY');
    expect(migration).toContain('v TEXT');
  });

  it('writes the heartbeat without runtime DDL', async () => {
    const calls: { query: string; parameters: unknown[] }[] = [];
    const sql = {
      unsafe: async (query: string, parameters: unknown[] = []) => {
        calls.push({ query, parameters });
        return { count: 1 };
      },
    } as unknown as Sql;

    await upsertHeartbeat(sql);

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain('INSERT INTO _seedkeep_kv');
    expect(calls[0].query).not.toContain('CREATE TABLE');
    expect(calls[0].parameters[0]).toBe('worker_last_tick');
    expect(Number(calls[0].parameters[1])).toBeGreaterThan(0);
  });

  it('does not create the shared table in the moderation worker', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/lib/catalog/moderationWorker.ts'),
      'utf8',
    );

    expect(source).not.toContain('CREATE TABLE IF NOT EXISTS _seedkeep_kv');
  });
});
