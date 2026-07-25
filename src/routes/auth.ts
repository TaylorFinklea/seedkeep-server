import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../index';
import { getAuth } from '../lib/auth';
import { requireAuth } from '../middleware/auth';
import { dbGet, dbAll } from '../db/helpers';
import { getSql } from '../db/client';
import { deletePhoto } from '../lib/storage';
import { TRANSFER_PHASE_SOURCE_DELETED } from './account-deletion-transfers';

export const authRoutes = new Hono<AppEnv>();

/**
 * What the client did about its CloudKit garden before asking us to erase
 * the account. The server cannot see CloudKit: shares, zones, and
 * participants leave no trace in `memberships`, so membership counts say
 * nothing about whether a garden is shared or who owns it. The device
 * therefore states its disposition explicitly, and the only claim the
 * server can check on its own — a shared-owner handoff — is checked
 * against the durable transfer row.
 *
 *   no_cloudkit_garden      — no iCloud garden to dispose of.
 *   participant_left_share  — participant left the CKShare and verified
 *                             the shared zone is no longer active.
 *   owner_zone_deleted      — owner deleted their own record zone and
 *                             verified its absence.
 *   transfer_source_deleted — shared owner completed a verified transfer;
 *                             requires `transfer_id` in `source_deleted`.
 *
 * There is no default. An absent or unrecognized disposition fails closed
 * so that a client which has not done its CloudKit work — including an
 * older build that never learned to send one — cannot destroy an account
 * whose garden is still live.
 */
const CLOUDKIT_DISPOSITIONS = [
  'no_cloudkit_garden',
  'participant_left_share',
  'owner_zone_deleted',
  'transfer_source_deleted',
] as const;

const deleteAccountBody = z
  .object({
    cloudkit_disposition: z.enum(CLOUDKIT_DISPOSITIONS),
    transfer_id: z.string().min(1).max(64).optional(),
  })
  .strict();

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
 * Two gates, both inside one transaction so a concurrent transfer step
 * cannot slip between them.
 *
 * 1. CloudKit gate. The caller states an explicit `cloudkit_disposition`
 *    (see above); there is no default. Every uncancelled transfer the
 *    caller is a party to is locked `FOR UPDATE` first, which serializes
 *    this request against `POST /transfers/:id/source-deleted`.
 *      - Bound successor of an unfinished handoff → refused. Their
 *        destination zone is the only verified copy of the garden until
 *        the owner records the source gone; letting them erase it would
 *        destroy both copies.
 *      - `transfer_source_deleted` → the named transfer must belong to
 *        the caller and be in the `source_deleted` phase.
 *      - Any other disposition while the caller owns an unfinished
 *        transfer → refused, so an in-flight handoff can never be
 *        sidestepped by claiming a simpler role.
 *
 * 2. Server-data rule (least-destructive), reached only after gate 1:
 *    - Sole member → hard-delete the household (cascades all garden data).
 *    - Other members remain, caller is NOT the only owner → delete only
 *      the caller's membership + user row; household survives.
 *    - Other members remain, caller IS the only owner → promote the
 *      oldest-joined other member to owner, then delete the caller.
 *    - No household at all → delete only the user row.
 *
 *    These counts describe who owns rows in *this* database. They say
 *    nothing about CloudKit — that is entirely gate 1's job.
 *
 * S3 objects are collected inside the transaction and deleted best-effort
 * after it commits, so a rolled-back deletion never orphans a live
 * household's photos.
 *
 * Always last in the tx: DELETE FROM "user" WHERE id=$userId
 * (cascades session/account/oauthAccessToken/oauthConsent/oauthApplication
 *  and the caller's account_deletion_transfers rows;
 *  SET-NULLs catalog_feedback.user_id + invites.claimed_by).
 *
 * Returns { ok: true, data: { deleted: true } } on success.
 */
authRoutes.delete('/me', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const sql = getSql(c.env);

  // ── Gate 1 · CloudKit disposition ──────────────────────────────────────
  const parsed = deleteAccountBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        ok: false,
        error: {
          code: 'cloudkit_disposition_required',
          message:
            'Finish the iCloud garden step first, then send cloudkit_disposition with the deletion request.',
        },
      },
      400,
    );
  }
  const { cloudkit_disposition: disposition, transfer_id: transferId } = parsed.data;

  interface TransferPartyRow {
    id: string;
    owner_user_id: string;
    successor_user_id: string | null;
    phase: string;
  }

  type DeleteOutcome =
    | { kind: 'blocked'; message: string }
    | { kind: 'deleted'; photoKeys: readonly string[] };

  const outcome: DeleteOutcome = await sql.begin(async (tx) => {
    // ── Gate 1 · CloudKit disposition ────────────────────────────────────
    // Lock every uncancelled transfer this account is a party to. The lock
    // is what makes the gate race-safe: the transfer routes take the same
    // row lock, so a phase change can never land between check and delete.
    const parties = await tx.unsafe<TransferPartyRow[]>(
      `SELECT id, owner_user_id, successor_user_id, phase
         FROM account_deletion_transfers
        WHERE phase <> 'cancelled'
          AND (owner_user_id = $1 OR successor_user_id = $1)
        ORDER BY id
        FOR UPDATE`,
      [userId],
    );

    const boundAsSuccessor = parties.find(
      (t) => t.successor_user_id === userId && t.phase !== TRANSFER_PHASE_SOURCE_DELETED,
    );
    if (boundAsSuccessor) {
      return {
        kind: 'blocked',
        message:
          'You are the successor of a garden handoff that is still in progress. Wait for it to finish or be cancelled before deleting this account.',
      } as const;
    }

    if (disposition === 'transfer_source_deleted') {
      const claimed = parties.find((t) => t.id === transferId && t.owner_user_id === userId);
      if (claimed?.phase !== TRANSFER_PHASE_SOURCE_DELETED) {
        return {
          kind: 'blocked',
          message:
            'Complete the shared-garden transfer and delete the original iCloud zone before deleting this account.',
        } as const;
      }
    } else if (
      parties.some(
        (t) => t.owner_user_id === userId && t.phase !== TRANSFER_PHASE_SOURCE_DELETED,
      )
    ) {
      // A handoff is under way. Whatever the device believes its role is,
      // the shared garden has not moved yet.
      return {
        kind: 'blocked',
        message:
          'A shared-garden transfer is in progress. Finish or cancel it before deleting this account.',
      } as const;
    }

    // ── Gate 2 · server-data disposal ────────────────────────────────────
    const membershipRows = await tx.unsafe<{ household_id: string }[]>(
      `SELECT household_id
         FROM memberships
        WHERE user_id = $1
        ORDER BY joined_at DESC
        LIMIT 1`,
      [userId],
    );
    const householdId = membershipRows[0]?.household_id ?? null;

    if (householdId === null) {
      // No household — delete only the user row.
      await tx.unsafe(`DELETE FROM "user" WHERE id = $1`, [userId]);
      return { kind: 'deleted', photoKeys: [] } as const;
    }

    const allMembers = await tx.unsafe<{ user_id: string; role: string }[]>(
      `SELECT user_id, role
         FROM memberships
        WHERE household_id = $1
        ORDER BY joined_at ASC`,
      [householdId],
    );

    const otherMembers = allMembers.filter((m) => m.user_id !== userId);

    if (otherMembers.length === 0) {
      // Collect S3 keys from all 3 sources; they are deleted after commit.
      const seedPhotos = await tx.unsafe<{ r2_key: string }[]>(
        `SELECT r2_key FROM seed_photos WHERE household_id = $1`,
        [householdId],
      );
      const journalPhotos = await tx.unsafe<{ storage_key: string }[]>(
        `SELECT storage_key FROM journal_entry_photos WHERE household_id = $1`,
        [householdId],
      );
      const extractions = await tx.unsafe<{ source_photo_keys: string }[]>(
        `SELECT source_photo_keys FROM catalog_extractions WHERE submitted_by_household = $1`,
        [householdId],
      );

      const extractionKeys: string[] = extractions.flatMap((e) => {
        try {
          const keys: unknown = JSON.parse(e.source_photo_keys);
          return Array.isArray(keys) ? (keys as string[]) : [];
        } catch {
          return [];
        }
      });

      // Hard-delete the household (cascades all child rows), then the user.
      await tx.unsafe(`DELETE FROM households WHERE id = $1`, [householdId]);
      await tx.unsafe(`DELETE FROM "user" WHERE id = $1`, [userId]);

      return {
        kind: 'deleted',
        photoKeys: [
          ...seedPhotos.map((p) => p.r2_key),
          ...journalPhotos.map((p) => p.storage_key),
          ...extractionKeys,
        ],
      } as const;
    }

    // Someone else still has rows in this household, so it survives. If
    // the caller was its only owner, hand row ownership to the oldest
    // remaining member (a verified transfer has already made the successor
    // an owner, so this only fires for un-transferred households).
    const heir = otherMembers.some((m) => m.role === 'owner') ? null : otherMembers[0];
    if (heir) {
      await tx.unsafe(
        `UPDATE memberships SET role = 'owner' WHERE household_id = $1 AND user_id = $2`,
        [householdId, heir.user_id],
      );
    }
    await tx.unsafe(
      `DELETE FROM memberships WHERE household_id = $1 AND user_id = $2`,
      [householdId, userId],
    );
    await tx.unsafe(`DELETE FROM "user" WHERE id = $1`, [userId]);

    return { kind: 'deleted', photoKeys: [] } as const;
  });

  if (outcome.kind === 'blocked') {
    return c.json(
      { ok: false, error: { code: 'cloudkit_transfer_required', message: outcome.message } },
      409,
    );
  }

  // Best-effort S3 deletion — mirrors seeds.ts:467-478.
  await Promise.allSettled(outcome.photoKeys.map((k) => deletePhoto(c.env, k)));

  return c.json({ ok: true, data: { deleted: true } });
});
