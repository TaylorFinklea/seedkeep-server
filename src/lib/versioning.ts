import type { Context } from 'hono';
import type { AppEnv } from '../index';

/**
 * Optimistic concurrency for garden writes (web M1 Phase 3).
 *
 * Clients send `If-Match: "<version>"` (or a bare `<version>`). Absent means
 * legacy last-write-wins for old native clients.
 */
export function expectedVersion(c: Context<AppEnv>): number | null | 'invalid' {
  const raw = c.req.header('If-Match');
  if (raw === undefined) return null;
  const match = /^\s*(?:W\/)?"?(\d{1,15})"?\s*$/.exec(raw);
  if (!match) return 'invalid';
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n >= 1 ? n : 'invalid';
}

/** 400 response for a malformed If-Match header. */
export function invalidIfMatch(c: Context<AppEnv>) {
  return c.json(
    { ok: false, error: { code: 'bad_request', message: 'If-Match must be a positive integer version' } },
    400,
  );
}

/** Set `ETag: "<version>"` on the response. */
export function setVersionHeader(c: Context<AppEnv>, version: number | bigint | string): void {
  c.header('ETag', `"${String(version)}"`);
}

/**
 * 409 for a stale write. `current` is the row in the route's normal response
 * shape, or null when the row no longer exists (deleted).
 */
export function versionConflict(c: Context<AppEnv>, current: unknown) {
  return c.json(
    {
      ok: false,
      error: { code: 'version_conflict', message: 'This record changed since you loaded it.' },
      data: { current },
    },
    409,
  );
}
