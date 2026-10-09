import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../index';
import { dbGet } from '../db/helpers';
import { getSql } from '../db/client';
import { getAuth, getSessionCookie } from '../lib/auth';
import { isAllowedAppOrigin } from '../lib/web/origins';

interface SessionRow {
  id: string;
  userId: string;
  token: string;
}

/**
 * Validates native Bearer tokens against the better-auth `session` row and
 * browser credentials through better-auth's signed session cookie. Unsafe
 * cookie requests must also pass the exact-Origin check.
 *
 * The expiry comparison happens in SQL against `NOW()` because session
 * timestamps are TIMESTAMPTZ (better-auth's native shape) — bouncing
 * them back to JS as numbers just to compare to Date.now() would invite
 * timezone drift.
 */
export const requireAuth = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const authHeader = c.req.header('Authorization');
    const cookieHeader = c.req.header('Cookie') ?? '';
    const auth = getAuth(c.env);
    const cookie = await getSessionCookie(c.env);
    const cookieTokenPresent = cookieHeader.split(';').some((part) => part.trim().startsWith(`${cookie.name}=`));

    const unauthorized = () => c.json(
      { ok: false, error: { code: 'unauthorized', message: 'Missing or invalid session credentials' } },
      401,
    );

    if (authHeader !== undefined) {
      if (!authHeader.startsWith('Bearer ') || !authHeader.slice(7).trim()) return unauthorized();
      const token = authHeader.slice(7).trim();
      const sql = getSql(c.env);
      const session = await dbGet<SessionRow>(
        sql,
        `SELECT id, "userId", token FROM session WHERE token = $1 AND "expiresAt" > NOW() LIMIT 1`,
        [token],
      );
      if (!session) return unauthorized();

      if (cookieTokenPresent) {
        const cookieOnlyHeaders = new Headers();
        cookieOnlyHeaders.set('cookie', cookieHeader);
        const result = await auth.api.getSession({ headers: cookieOnlyHeaders });
        if (result && result.user.id !== session.userId) {
          return c.json(
            { ok: false, error: { code: 'conflicting_credentials', message: 'Bearer and cookie credentials identify different users' } },
            401,
          );
        }
      }
      c.set('userId', session.userId);
      c.set('authMethod', 'bearer');
      await next();
      return;
    }

    if (!cookieTokenPresent) {
      return unauthorized();
    }

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method.toUpperCase())
      && !isAllowedAppOrigin(c.env, c.req.header('Origin'))) {
      return c.json(
        { ok: false, error: { code: 'csrf_origin_rejected', message: 'Request Origin is not allowed' } },
        403,
      );
    }

    const sessionResult = await auth.api.getSession({ headers: c.req.raw.headers, returnHeaders: true });
    const session = sessionResult.response;
    if (!session) return unauthorized();

    for (const value of sessionResult.headers.getSetCookie()) {
      c.header('Set-Cookie', value, { append: true });
    }
    c.set('userId', session.user.id);
    c.set('authMethod', 'cookie');
    await next();
  });
