/**
 * Unit tests for the reusable per-user count-window rate limiter.
 */

import { describe, it, expect } from 'vitest';
import { checkRateLimit } from '../rateLimit';
import type { Sql } from 'postgres';

// Minimal fake sql that returns a configurable count.
function makeSql(count: number): Sql {
  return {
    unsafe: async () => [{ n: count }],
  } as unknown as Sql;
}

describe('checkRateLimit', () => {
  it('returns limited:false when count is below the limit', async () => {
    const sql = makeSql(5);
    const result = await checkRateLimit(sql, {
      scopeId: 'user-1',
      table: 'seed_photos',
      windowMs: 3_600_000,
      limit: 20,
      retryAfterSeconds: 3600,
    });
    expect(result.limited).toBe(false);
  });

  it('returns limited:false when count equals limit minus one', async () => {
    const sql = makeSql(19);
    const result = await checkRateLimit(sql, {
      scopeId: 'user-1',
      table: 'seed_photos',
      windowMs: 3_600_000,
      limit: 20,
      retryAfterSeconds: 3600,
    });
    expect(result.limited).toBe(false);
  });

  it('returns limited:true when count equals the limit', async () => {
    const sql = makeSql(20);
    const result = await checkRateLimit(sql, {
      scopeId: 'user-1',
      table: 'seed_photos',
      windowMs: 3_600_000,
      limit: 20,
      retryAfterSeconds: 3600,
    });
    expect(result.limited).toBe(true);
    if (result.limited) {
      expect(result.response.error.code).toBe('rate_limited');
      expect(result.response.retry_after_seconds).toBe(3600);
    }
  });

  it('returns limited:true when count exceeds the limit', async () => {
    const sql = makeSql(50);
    const result = await checkRateLimit(sql, {
      scopeId: 'user-1',
      table: 'seed_photos',
      windowMs: 3_600_000,
      limit: 20,
      retryAfterSeconds: 3600,
    });
    expect(result.limited).toBe(true);
  });

  it('uses custom scopeColumn when provided', async () => {
    let capturedQuery = '';
    const sql = {
      unsafe: async (q: string) => {
        capturedQuery = q;
        return [{ n: 0 }];
      },
    } as unknown as Sql;

    await checkRateLimit(sql, {
      scopeId: 'household-1',
      scopeColumn: 'household_id',
      table: 'seed_photos',
      windowMs: 3_600_000,
      limit: 20,
      retryAfterSeconds: 3600,
    });

    expect(capturedQuery).toContain('household_id = $1');
  });

  it('uses custom createdAtColumn when provided', async () => {
    let capturedQuery = '';
    const sql = {
      unsafe: async (q: string) => {
        capturedQuery = q;
        return [{ n: 0 }];
      },
    } as unknown as Sql;

    await checkRateLimit(sql, {
      scopeId: 'user-1',
      table: 'seed_photos',
      createdAtColumn: 'captured_at',
      windowMs: 3_600_000,
      limit: 20,
      retryAfterSeconds: 3600,
    });

    expect(capturedQuery).toContain('captured_at > $2');
  });

  it('uses custom message in the response', async () => {
    const sql = makeSql(99);
    const result = await checkRateLimit(sql, {
      scopeId: 'user-1',
      table: 'seed_photos',
      windowMs: 3_600_000,
      limit: 20,
      retryAfterSeconds: 1800,
      message: 'too many photo uploads this hour',
    });
    expect(result.limited).toBe(true);
    if (result.limited) {
      expect(result.response.error.message).toBe('too many photo uploads this hour');
      expect(result.response.retry_after_seconds).toBe(1800);
    }
  });
});
