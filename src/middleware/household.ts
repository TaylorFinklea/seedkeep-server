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
 * Existing clients without a household header keep the newest-membership
 * default. Web clients may select one of their memberships explicitly;
 * that id is validated against both membership and active-household rows.
 */
export const requireHousehold = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const userId = c.get('userId');
    const sql = getSql(c.env);
    const requestedHouseholdId = c.req.header('X-Household-Id');
    if (requestedHouseholdId !== undefined) {
      const selected = await dbGet<MembershipRow>(
        sql,
        `SELECT m.household_id, m.user_id, m.role
           FROM memberships m
           JOIN households h ON h.id = m.household_id
          WHERE m.user_id = $1 AND m.household_id = $2 AND h.deleted_at IS NULL
          LIMIT 1`,
        [userId, requestedHouseholdId],
      );
      if (!selected) {
        return c.json(
          { ok: false, error: { code: 'not_a_member', message: 'Not a member of this household.' } },
          403,
        );
      }
      c.set('householdId', selected.household_id);
      await next();
      return;
    }

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
