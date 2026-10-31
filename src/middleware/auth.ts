import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../index';
import { dbGet } from '../db/helpers';
import { getSql } from '../db/client';
import { getAuth } from '../lib/auth';
import { isWebOriginAllowed } from '../lib/webOrigins';
import { splitSetCookieHeader } from 'better-auth/cookies';

interface SessionRow {
  id: string;
  userId: string;
  token: string;
}

/**
 * Supports native Bearer sessions and browser Better Auth cookie sessions.
 * Unsafe cookie-authenticated requests require an exact configured Origin
 * to prevent cross-site request forgery. Bearer-authenticated native clients
 * retain their existing header-based flow.
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

    if (token) {
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
      return;
    }

    const method = c.req.method.toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !isWebOriginAllowed(c.env, c.req.header('Origin'))) {
      return c.json(
        { ok: false, error: { code: 'csrf_origin_rejected', message: 'Request origin is not allowed' } },
        403,
      );
    }

    const sessionResult = await getAuth(c.env).api.getSession({
      headers: c.req.raw.headers,
      query: { disableCookieCache: true },
      returnHeaders: true,
    });
    const session = sessionResult.response;
    const resultHeaders = sessionResult.headers as Headers & { getSetCookie?: () => string[] };
    const refreshedCookies = resultHeaders.getSetCookie?.()
      ?? splitSetCookieHeader(resultHeaders.get('set-cookie') ?? '');
    for (const cookie of refreshedCookies) c.header('set-cookie', cookie, { append: true });
    if (!session) {
      return c.json(
        { ok: false, error: { code: 'unauthorized', message: 'Missing or invalid session' } },
        401,
      );
    }
    c.set('userId', session.user.id);
    await next();
  });
