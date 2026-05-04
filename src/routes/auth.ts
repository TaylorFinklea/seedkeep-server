import { Hono } from 'hono';
import type { AppEnv } from '../index';
import { getAuth } from '../lib/auth';
import { requireAuth } from '../middleware/auth';
import { dbGet } from '../db/helpers';
import { getSql } from '../db/client';

export const authRoutes = new Hono<AppEnv>();

/**
 * Delegate every /api/auth/* request to better-auth. iOS hits
 * /api/auth/sign-in/social with an Apple id_token; better-auth verifies
 * the token, creates the user/account/session rows, and returns a
 * Bearer token in the response body.
 */
authRoutes.all('/auth/*', async (c) => {
  const auth = getAuth(c.env);
  return auth.handler(c.req.raw);
});

/**
 * GET /api/me — minimal identity probe for the signed-in user.
 *
 * Used by the iOS client right after sign-in to fetch the user row and
 * the user's household. Returns 401 if the Bearer token is missing or
 * invalid.
 */
authRoutes.get('/me', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const sql = getSql(c.env);
  const user = await dbGet<{ id: string; name: string | null; email: string | null }>(
    sql,
    `SELECT id, name, email FROM "user" WHERE id = $1 LIMIT 1`,
    [userId],
  );
  if (!user) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'User not found' } }, 404);
  }
  return c.json({ ok: true, data: { user } });
});
