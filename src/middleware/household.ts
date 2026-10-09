import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../index';
import { dbGet } from '../db/helpers';
import { getSql } from '../db/client';

interface MembershipRow {
  household_id: string;
  user_id: string;
  role: 'owner' | 'member';
}

/**
 * Resolves the signed-in user's household membership and sets
 * `c.var.householdId`. Mount AFTER `requireAuth()` on every per-household
 * route. Substitutes for missing native row-level security — every
 * downstream query must filter by `household_id`.
 *
 * X-Household-Id can select any membership held by the caller. Older clients
 * omit it and retain the most-recent-membership behavior.
 */
export const requireHousehold = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const userId = c.get('userId');
    const sql = getSql(c.env);
    const selectedId = c.req.header('X-Household-Id');
    const membership = await dbGet<MembershipRow>(
      sql,
      `SELECT household_id, user_id, role
         FROM memberships
        WHERE user_id = $1
          AND ($2::text IS NULL OR household_id = $2)
        ORDER BY joined_at DESC
        LIMIT 1`,
      [userId, selectedId ?? null],
    );

    if (!membership) {
      if (selectedId !== undefined) {
        return c.json({ ok: false, error: { code: 'household_forbidden', message: 'Household is not available to this user' } }, 403);
      }
      return c.json(
        {
          ok: false,
          error: {
            code: 'no_household',
            message: 'No household for this user. POST /api/households to create one.',
          },
        },
        409,
      );
    }

    c.set('householdId', membership.household_id);
    await next();
  });
