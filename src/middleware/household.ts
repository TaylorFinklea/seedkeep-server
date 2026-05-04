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
 * Phase 1 enforces a 1:1 user-to-household relationship at the API layer:
 * if the user has more than one membership row (which shouldn't happen
 * in Phase 1) we pick the most recent one. The schema permits multiple
 * memberships so we can lift the restriction later.
 */
export const requireHousehold = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const userId = c.get('userId');
    const sql = getSql(c.env);
    const membership = await dbGet<MembershipRow>(
      sql,
      `SELECT household_id, user_id, role
         FROM memberships
        WHERE user_id = $1
        ORDER BY joined_at DESC
        LIMIT 1`,
      [userId],
    );

    if (!membership) {
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
