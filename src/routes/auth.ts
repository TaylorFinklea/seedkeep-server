import { Hono } from 'hono';
import type { AppEnv } from '../index';
import { getAuth } from '../lib/auth';
import { requireAuth } from '../middleware/auth';
import { dbGet, dbAll } from '../db/helpers';
import { getSql } from '../db/client';
import { deletePhoto } from '../lib/storage';

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

/**
 * DELETE /api/me — permanently delete the authenticated user's account.
 *
 * Last-owner-of-household rule (least-destructive-compliant):
 *   - Sole member → hard-delete the household (cascades all garden data).
 *     S3 objects are deleted best-effort BEFORE the transaction.
 *   - Other members remain, caller is NOT the only owner → delete only
 *     the caller's membership + user row; household survives.
 *   - Other members remain, caller IS the only owner → promote the
 *     oldest-joined other member to owner, then delete the caller.
 *   - No household at all → delete only the user row.
 *
 * Always last in the tx: DELETE FROM "user" WHERE id=$userId
 * (cascades session/account/oauthAccessToken/oauthConsent/oauthApplication;
 *  SET-NULLs catalog_feedback.user_id + invites.claimed_by).
 *
 * Returns { ok: true, data: { deleted: true } } on success.
 */
authRoutes.delete('/me', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const sql = getSql(c.env);

  // Resolve caller's household — most recent membership if any.
  const membership = await dbGet<{ household_id: string; joined_at: number }>(
    sql,
    `SELECT household_id, joined_at
       FROM memberships
      WHERE user_id = $1
      ORDER BY joined_at DESC
      LIMIT 1`,
    [userId],
  );

  const householdId = membership?.household_id ?? null;

  if (householdId !== null) {
    // Fetch all memberships for this household to determine the branch.
    const allMembers = await dbAll<{ user_id: string; role: string; joined_at: number }>(
      sql,
      `SELECT user_id, role, joined_at
         FROM memberships
        WHERE household_id = $1
        ORDER BY joined_at ASC`,
      [householdId],
    );

    const isSoleMember = allMembers.length === 1;
    const otherMembers = allMembers.filter((m) => m.user_id !== userId);
    const otherOwners = allMembers.filter((m) => m.user_id !== userId && m.role === 'owner');
    const isOnlyOwner = otherOwners.length === 0 && !isSoleMember;

    if (isSoleMember) {
      // Collect S3 keys from all 3 sources best-effort BEFORE the tx.
      const seedPhotos = await dbAll<{ r2_key: string }>(
        sql,
        `SELECT r2_key FROM seed_photos WHERE household_id = $1`,
        [householdId],
      );
      const journalPhotos = await dbAll<{ storage_key: string }>(
        sql,
        `SELECT storage_key FROM journal_entry_photos WHERE household_id = $1`,
        [householdId],
      );
      const extractions = await dbAll<{ source_photo_keys: string }>(
        sql,
        `SELECT source_photo_keys FROM catalog_extractions WHERE submitted_by_household = $1`,
        [householdId],
      );

      const extractionKeys: string[] = extractions.flatMap((e) => {
        try {
          const parsed = JSON.parse(e.source_photo_keys);
          return Array.isArray(parsed) ? (parsed as string[]) : [];
        } catch {
          return [];
        }
      });

      const allKeys: string[] = [
        ...seedPhotos.map((p) => p.r2_key),
        ...journalPhotos.map((p) => p.storage_key),
        ...extractionKeys,
      ];

      // Best-effort S3 deletion — mirrors seeds.ts:467-478.
      await Promise.allSettled(allKeys.map((k) => deletePhoto(c.env, k)));

      // Transaction: hard-delete household (cascades all child rows),
      // then delete the user row.
      await sql.begin(async (tx) => {
        await tx.unsafe(`DELETE FROM households WHERE id = $1`, [householdId]);
        await tx.unsafe(`DELETE FROM "user" WHERE id = $1`, [userId]);
      });
    } else if (isOnlyOwner) {
      // Promote oldest-joined other member to owner, then delete caller.
      const oldestOther = otherMembers[0]!;
      await sql.begin(async (tx) => {
        await tx.unsafe(
          `UPDATE memberships SET role = 'owner' WHERE household_id = $1 AND user_id = $2`,
          [householdId, oldestOther.user_id],
        );
        await tx.unsafe(
          `DELETE FROM memberships WHERE household_id = $1 AND user_id = $2`,
          [householdId, userId],
        );
        await tx.unsafe(`DELETE FROM "user" WHERE id = $1`, [userId]);
      });
    } else {
      // Other owners exist or caller is not the only owner — remove membership only.
      await sql.begin(async (tx) => {
        await tx.unsafe(
          `DELETE FROM memberships WHERE household_id = $1 AND user_id = $2`,
          [householdId, userId],
        );
        await tx.unsafe(`DELETE FROM "user" WHERE id = $1`, [userId]);
      });
    }
  } else {
    // No household — delete only the user row.
    await sql.begin(async (tx) => {
      await tx.unsafe(`DELETE FROM "user" WHERE id = $1`, [userId]);
    });
  }

  return c.json({ ok: true, data: { deleted: true } });
});
