import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../index';
import { dbGet } from '../db/helpers';
import { getSql } from '../db/client';

interface SessionRow {
  id: string;
  userId: string;
  token: string;
  expiresAt: number;
}

/**
 * Validates a Bearer token by looking up the better-auth `session` row in
 * Postgres. iOS clients send `Authorization: Bearer <token>` after a
 * `/api/auth/sign-in/social` round-trip; better-auth's cookie path is
 * unused on native.
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
      `SELECT id, "userId", token, "expiresAt"::bigint AS "expiresAt"
         FROM session
        WHERE token = $1
        LIMIT 1`,
      [token],
    );

    if (!session) {
      return c.json(
        { ok: false, error: { code: 'unauthorized', message: 'Invalid session token' } },
        401,
      );
    }

    if (Number(session.expiresAt) < Date.now()) {
      return c.json(
        { ok: false, error: { code: 'unauthorized', message: 'Session expired' } },
        401,
      );
    }

    c.set('userId', session.userId);
    await next();
  });
