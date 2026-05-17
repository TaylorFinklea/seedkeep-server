import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../index';
import { dbGet } from '../db/helpers';
import { getSql } from '../db/client';

interface SessionRow {
  id: string;
  userId: string;
  token: string;
}

/**
 * Validates a Bearer token by looking up the better-auth `session` row in
 * Postgres. iOS clients send `Authorization: Bearer <token>` after a
 * `/api/auth/sign-in/social` round-trip; better-auth's cookie path is
 * unused on native.
 *
 * The expiry comparison happens in SQL against `NOW()` because session
 * timestamps are TIMESTAMPTZ (better-auth's native shape) — bouncing
 * them back to JS as numbers just to compare to Date.now() would invite
 * timezone drift.
 */
export const requireAuth = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const authHeader = c.req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return c.json(
        { ok: false, error: { code: 'unauthorized', message: 'Missing authorization token' } },
        401,
      );
    }

    const sql = getSql(c.env);
    const session = await dbGet<SessionRow>(
      sql,
      `SELECT id, "userId", token
         FROM session
        WHERE token = $1
          AND "expiresAt" > NOW()
        LIMIT 1`,
      [token],
    );

    if (!session) {
      return c.json(
        { ok: false, error: { code: 'unauthorized', message: 'Invalid or expired session token' } },
        401,
      );
    }

    c.set('userId', session.userId);
    await next();
  });
