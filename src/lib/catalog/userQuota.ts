/**
 * Phase 4D · Role-based auto-apply quota.
 *
 * Defaults:                         5 auto-applies / rolling 24h
 * Power-user threshold:             50 auto-applies / rolling 24h
 *   IFF lifetime auto-applies >= 10 AND lifetime reverts === 0
 *
 * One revert in a user's history drops them back to the default tier
 * permanently. (Reverts are rare and indicate genuine error — staying at
 * default is acceptable punitive cost for catalog quality.)
 *
 * Pure `computeUserQuota` so unit tests can sweep the boundary
 * conditions; DB-backed `fetchUserQuotaStats` is split out so the worker
 * can pull stats in one query.
 */

import type { Sql } from 'postgres';

export interface UserQuotaStats {
  lifetimeAutoApplies: number;
  lifetimeReverts: number;
  autoAppliesLast24h: number;
}

export interface UserQuotaResult {
  dailyCeiling: 5 | 50;
  remaining: number;
  isPowerUser: boolean;
}

const POWER_USER_AUTO_APPLY_MIN = 10;

export function computeUserQuota(stats: UserQuotaStats): UserQuotaResult {
  const isPowerUser =
    stats.lifetimeAutoApplies >= POWER_USER_AUTO_APPLY_MIN && stats.lifetimeReverts === 0;
  const dailyCeiling: 5 | 50 = isPowerUser ? 50 : 5;
  const remaining = Math.max(0, dailyCeiling - stats.autoAppliesLast24h);
  return { dailyCeiling, remaining, isPowerUser };
}

/**
 * Lifetime + last-24h auto-apply stats for `userId`. Only worker
 * auto-applies (source='auto_apply' in catalog_audit_log) count toward
 * power-user promotion and daily quota. Admin manual approvals
 * (source='manual_apply') are excluded so that operators triaging the queue
 * do not inadvertently inflate users' stats.
 */
export async function fetchUserQuotaStats(sql: Sql, userId: string): Promise<UserQuotaStats> {
  const oneDayAgo = Date.now() - 86_400_000;

  // Three counts in a single round-trip. Only rows with a matching
  // auto_apply audit entry count — manual_apply rows are excluded.
  const rows = await sql.unsafe<
    { lifetime_auto: number; reverts: number; daily_auto: number }[]
  >(
    `
    SELECT
      (SELECT count(*)::int FROM catalog_feedback cf
        JOIN catalog_audit_log al ON al.correction_id = cf.id AND al.source = 'auto_apply'
        WHERE cf.user_id = $1 AND cf.status = 'applied') AS lifetime_auto,
      (SELECT count(*)::int FROM catalog_audit_log al
        JOIN catalog_feedback cf ON cf.id = al.correction_id
        WHERE cf.user_id = $1 AND al.source = 'manual_revert') AS reverts,
      (SELECT count(*)::int FROM catalog_feedback cf
        JOIN catalog_audit_log al ON al.correction_id = cf.id AND al.source = 'auto_apply'
        WHERE cf.user_id = $1 AND cf.status = 'applied' AND cf.applied_at >= $2) AS daily_auto
    `,
    [userId, oneDayAgo],
  );
  const r = rows[0] ?? { lifetime_auto: 0, reverts: 0, daily_auto: 0 };
  return {
    lifetimeAutoApplies: Number(r.lifetime_auto ?? 0),
    lifetimeReverts: Number(r.reverts ?? 0),
    autoAppliesLast24h: Number(r.daily_auto ?? 0),
  };
}
