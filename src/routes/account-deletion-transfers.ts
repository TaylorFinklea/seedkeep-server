// CloudKit account-deletion transfers — the server half of the
// shared-owner handoff described in
// `.docs/ai/phases/2026-07-23-cloudkit-account-deletion-spec.md`.
//
// A shared garden lives in the owner's CloudKit record zone. If the owner
// deletes that zone, every CKShare participant loses the garden, so
// `DELETE /api/me` refuses a shared-owner deletion unless a transfer in
// the `source_deleted` phase says the garden already moved (auth.ts).
// This router runs that move: the owner nominates a successor, the
// successor builds a destination zone and share *they* own, the owner
// copies the graph, and both devices post a canonical digest with per-type
// counts. Only when those two documents agree does the server mark the
// transfer verified, re-home membership ownership, and unlock source
// deletion.
//
// The server never receives garden record contents. It stores the parties,
// zone/share identifiers, digest/count documents, a hashed single-use
// handoff token, the phase, and timestamps.
//
//   pending_successor → successor_bound → destination_ready
//     → owner_verified → verified → source_deleting → source_deleted
//
// Cancellation closes once `source_deleting` grants the owner an exclusive
// lease to destroy the source. Earlier phases may move to `cancelled`.
// Transitions run as `SELECT ... FOR UPDATE` plus a conditional
// `UPDATE ... WHERE phase = ANY(...)`
// inside one transaction (the convention `pets.ts` introduced), so two
// devices racing the same step cannot both win. Repeating a step that
// already landed returns the durable state instead of failing — the iOS
// coordinator retries every phase from its checkpoint.
//
// ── CloudKit roles are invisible here ────────────────────────────────────
// Server memberships and CKShare participation are *separate* graphs: a
// CKShare participant is generally not a `memberships` row, and a server
// membership implies nothing about the share. Nothing in this file infers
// a CloudKit role from membership counts. Authorization is by transfer
// party (owner / bound successor) and by the handoff token; whether a
// transfer is *needed* at all is the client's determination, since only
// the device can see the share.

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { AppEnv } from '../index';
import { getSql } from '../db/client';
import { dbGet, isUniqueViolation } from '../db/helpers';
import { requireAuth } from '../middleware/auth';

export const accountDeletionTransferRoutes = new Hono<AppEnv>();

// ── Constants ─────────────────────────────────────────────────────────────

/** Handoff tokens die after 72 hours (spec § "Security and expiry"). */
export const HANDOFF_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

/** 256 bits of randomness, base64url-encoded into the universal link. */
const HANDOFF_TOKEN_BYTES = 32;

export const TRANSFER_PHASES = [
  'pending_successor',
  'successor_bound',
  'destination_ready',
  'owner_verified',
  'verified',
  'source_deleting',
  'source_deleted',
  'cancelled',
] as const;

export type TransferPhase = (typeof TRANSFER_PHASES)[number];

/**
 * The only phase from which a shared owner may complete `DELETE /api/me`.
 * `auth.ts` imports this so the guard and the state machine cannot drift.
 */
export const TRANSFER_PHASE_SOURCE_DELETED = 'source_deleted' satisfies TransferPhase;

const COLUMNS = `id, source_household_id, owner_user_id, successor_user_id,
                 handoff_token_hash, handoff_expires_at, handoff_consumed_at,
                 source_deleting_at, phase, destination_zone_name,
                 destination_zone_owner_name, destination_share_record_name,
                 destination_share_url, owner_digest, successor_digest,
                 successor_prior_membership, created_at, updated_at, cancelled_at`;

/**
 * What the successor's membership looked like before re-home promoted
 * them. Cancelling a verified transfer restores exactly this.
 */
type PriorMembership = 'absent' | 'member' | 'owner';

// ── Types ─────────────────────────────────────────────────────────────────

interface DigestDoc {
  digest: string;
  record_counts: Record<string, number>;
  submitted_at: number;
}

interface TransferRow {
  id: string;
  source_household_id: string;
  owner_user_id: string;
  successor_user_id: string | null;
  handoff_token_hash: string;
  handoff_expires_at: number;
  handoff_consumed_at: number | null;
  source_deleting_at: number | null;
  phase: TransferPhase;
  destination_zone_name: string | null;
  destination_zone_owner_name: string | null;
  destination_share_record_name: string | null;
  destination_share_url: string | null;
  owner_digest: DigestDoc | null;
  successor_digest: DigestDoc | null;
  successor_prior_membership: PriorMembership | null;
  created_at: number;
  updated_at: number;
  cancelled_at: number | null;
}

type ErrorStatus = 400 | 403 | 404 | 409;

/**
 * Error envelope. Phase conflicts carry the durable phase so the client
 * reloads its checkpoint instead of guessing (spec § "Failure invariants":
 * "A server phase conflict reloads current state instead of guessing").
 */
function fail(
  c: Context<AppEnv>,
  status: ErrorStatus,
  code: string,
  message: string,
  phase?: TransferPhase,
) {
  return c.json({ ok: false, error: phase ? { code, message, phase } : { code, message } }, status);
}

/** Success envelope. The token hash never crosses the wire. */
function ok(c: Context<AppEnv>, row: TransferRow, handoffToken: string | null = null) {
  return c.json({
    ok: true,
    data: {
      transfer: {
        id: row.id,
        source_household_id: row.source_household_id,
        owner_user_id: row.owner_user_id,
        successor_user_id: row.successor_user_id,
        phase: row.phase,
        handoff_expires_at: row.handoff_expires_at,
        handoff_consumed_at: row.handoff_consumed_at,
        source_deleting_at: row.source_deleting_at,
        destination_zone_name: row.destination_zone_name,
        destination_zone_owner_name: row.destination_zone_owner_name,
        destination_share_record_name: row.destination_share_record_name,
        destination_share_url: row.destination_share_url,
        owner_digest: row.owner_digest,
        successor_digest: row.successor_digest,
        created_at: row.created_at,
        updated_at: row.updated_at,
        cancelled_at: row.cancelled_at,
      },
      handoff_token: handoffToken,
    },
  });
}

// ── Token handling ────────────────────────────────────────────────────────

/**
 * Handoff tokens are stored only as this digest. Minting and verification
 * must agree byte for byte or every handoff silently fails closed, so the
 * encoding lives in exactly one place.
 */
function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Constant-time comparison of a presented token against the stored hash. */
function tokenMatches(raw: string, storedHash: string): boolean {
  const provided = Buffer.from(hashToken(raw), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

// ── Bodies ────────────────────────────────────────────────────────────────

const acceptBody = z.object({ token: z.string().min(1).max(512) }).strict();

const receiptLookupBody = z
  .object({ receipt_token: z.string().min(1).max(512) })
  .strict();

const destinationBody = z
  .object({
    destination_zone_name: z.string().min(1).max(255),
    destination_zone_owner_name: z.string().min(1).max(255),
    destination_share_record_name: z.string().min(1).max(255),
    destination_share_url: z.string().min(1).max(2048).optional(),
  })
  .strict();

// A canonical SHA-256 over the copied graph plus a per-record-type census.
// Bounded so a hostile client cannot use the column as free storage.
const digestBody = z.object({
  digest: z.string().regex(/^[0-9a-f]{64}$/, 'digest must be 64 lowercase hex characters'),
  record_counts: z
    .record(z.string().min(1).max(64), z.number().int().min(0).max(1_000_000))
    .refine((counts) => Object.keys(counts).length <= 64, 'too many record types'),
});

const ownerVerificationBody = digestBody.strict();

const successorVerificationBody = digestBody
  .extend({
    // Ownership proof: the successor must name the zone it created and
    // still owns. A mismatch means the two devices are describing
    // different destinations, so the copy proves nothing.
    destination_zone_name: z.string().min(1).max(255),
    destination_zone_owner_name: z.string().min(1).max(255),
  })
  .strict();

async function parseBody<T>(
  c: Context<AppEnv>,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  const raw = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.message };
  return { ok: true, data: parsed.data };
}

// ── Digest comparison ─────────────────────────────────────────────────────

/**
 * Owner and successor documents must agree on both the graph digest and
 * the per-type record census before the source may be destroyed. Count
 * keys are compared as a set — a type present on one side but absent on
 * the other is a real difference worth failing on.
 */
function digestsAgree(
  stored: DigestDoc | null,
  posted: { digest: string; record_counts: Record<string, number> },
): boolean {
  if (!stored) return false;
  if (stored.digest !== posted.digest) return false;
  const storedKeys = Object.keys(stored.record_counts).sort();
  const postedKeys = Object.keys(posted.record_counts).sort();
  if (storedKeys.length !== postedKeys.length) return false;
  return storedKeys.every(
    (key, i) => postedKeys[i] === key && stored.record_counts[key] === posted.record_counts[key],
  );
}

// ── Row access + transitions ──────────────────────────────────────────────

async function lockTransfer(tx: TransactionSql, id: string): Promise<TransferRow | null> {
  const rows = await tx.unsafe<TransferRow[]>(
    `SELECT ${COLUMNS} FROM account_deletion_transfers WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Conditional transition. The `WHERE phase = ANY(expected)` predicate is
 * redundant under the row lock we already hold, but it keeps the guard
 * next to the write where a future refactor cannot lose it. A null return
 * means the durable phase moved — reload and report it.
 */
async function transition(
  tx: TransactionSql,
  id: string,
  expected: readonly TransferPhase[],
  assignments: string,
  params: readonly unknown[],
): Promise<TransferRow | null> {
  const rows = await tx.unsafe<TransferRow[]>(
    `UPDATE account_deletion_transfers
        SET ${assignments}
      WHERE id = $1 AND phase = ANY($2)
    RETURNING ${COLUMNS}`,
    [id, expected as unknown as string[], ...params] as never,
  );
  return rows[0] ?? null;
}

type Outcome =
  | { kind: 'ok'; row: TransferRow }
  | { kind: 'error'; status: ErrorStatus; code: string; message: string; phase?: TransferPhase };

const PHASE_CONFLICT = (row: TransferRow) =>
  ({
    kind: 'error',
    status: 409,
    code: 'phase_conflict',
    message: `Transfer is in phase '${row.phase}'. Reload and continue from there.`,
    phase: row.phase,
  }) as const;

/**
 * Runs `step` under the transfer's row lock after checking that the caller
 * holds `role`. Unknown ids 404; the wrong party — including an account
 * that is not the bound successor — gets 403 without learning the phase.
 */
async function withParty(
  sql: Sql,
  id: string,
  userId: string,
  role: 'owner' | 'successor' | 'either',
  step: (tx: TransactionSql, row: TransferRow) => Promise<Outcome>,
): Promise<Outcome> {
  return sql.begin(async (tx) => {
    const row = await lockTransfer(tx, id);
    if (!row) {
      return {
        kind: 'error',
        status: 404,
        code: 'not_found',
        message: 'Transfer not found',
      } as const;
    }
    const isOwner = row.owner_user_id === userId;
    const isSuccessor = row.successor_user_id !== null && row.successor_user_id === userId;
    const permitted =
      role === 'owner' ? isOwner : role === 'successor' ? isSuccessor : isOwner || isSuccessor;
    if (!permitted) {
      return {
        kind: 'error',
        status: 403,
        code: 'forbidden',
        message: 'You are not a party to this transfer with that role.',
      } as const;
    }
    return step(tx, row);
  });
}

/**
 * The source may be destroyed only while the bound successor still owns
 * the source household in server state. Both lease acquisition and final
 * source-deleted recording enforce this same invariant under the row lock.
 */
async function successorOwnsSource(tx: TransactionSql, row: TransferRow): Promise<boolean> {
  if (row.successor_user_id === null) return false;
  const memberships = await tx.unsafe<{ exists: boolean }[]>(
    `SELECT TRUE AS "exists"
       FROM memberships
      WHERE household_id = $1 AND user_id = $2 AND role = 'owner'
      LIMIT 1`,
    [row.source_household_id, row.successor_user_id],
  );
  return memberships.length === 1;
}

function respond(c: Context<AppEnv>, outcome: Outcome) {
  if (outcome.kind === 'error') {
    return fail(c, outcome.status, outcome.code, outcome.message, outcome.phase);
  }
  return ok(c, outcome.row);
}

// ── POST /receipts/lookup — recover a lost deletion response ──────────────

/**
 * This capability lookup is intentionally unauthenticated. Successful
 * account deletion cascades the caller's session, so the 256-bit raw
 * receipt token is the only credential available after response loss.
 */
accountDeletionTransferRoutes.post('/receipts/lookup', async (c) => {
  const body = await parseBody(c, receiptLookupBody);
  if (!body.ok) return fail(c, 400, 'bad_request', body.message);

  const receipt = await dbGet<{ deleted_at: number }>(
    getSql(c.env),
    `SELECT deleted_at
       FROM account_deletion_receipts
      WHERE receipt_hash = $1
      LIMIT 1`,
    [hashToken(body.data.receipt_token)],
  );
  if (!receipt) {
    return fail(c, 404, 'receipt_not_found', 'Account deletion receipt not found.');
  }
  return c.json({ ok: true, data: { deleted: true, deleted_at: receipt.deleted_at } });
});

// ── POST /transfers — create or resume ────────────────────────────────────

/**
 * Creates the owner's single active transfer, or resumes it.
 *
 * Eligibility is a *server* authorization check — the caller must own the
 * household row whose garden is moving. It deliberately does not count
 * members: CKShare participants have no membership rows, so a genuinely
 * shared garden can look like a one-person household from here. Only the
 * device can see the share, so the device decides whether a transfer is
 * needed; an unnecessary transfer is harmless and cancellable.
 *
 * Resume is idempotent: the same id, phase, and creation time come back.
 * The raw token cannot come back with it — only its hash is stored — so
 * `handoff_token` is null on resume. A pending expired token is reissued
 * automatically; an owner who lost an unexpired token uses the explicit
 * `/handoff-token` rotation route. Both paths invalidate the previous link.
 */
accountDeletionTransferRoutes.post('/transfers', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const sql = getSql(c.env);

  const membership = await dbGet<{ household_id: string; role: string }>(
    sql,
    `SELECT household_id, role
       FROM memberships
      WHERE user_id = $1
      ORDER BY joined_at DESC
      LIMIT 1`,
    [userId],
  );
  if (!membership || membership.role !== 'owner') {
    return fail(
      c,
      403,
      'forbidden',
      'Only the owner of a garden can start a deletion transfer.',
    );
  }

  const now = Date.now();
  const existing = await dbGet<TransferRow>(
    sql,
    `SELECT ${COLUMNS}
       FROM account_deletion_transfers
      WHERE owner_user_id = $1 AND phase <> 'cancelled'
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId],
  );

  if (existing) {
    if (existing.phase === 'pending_successor' && existing.handoff_expires_at <= now) {
      const raw = randomBytes(HANDOFF_TOKEN_BYTES).toString('base64url');
      // Compare-and-swap on the exact row we read. Two devices resuming
      // the same stale handoff must not each walk away believing they
      // hold the live token — only the winner gets a raw value back.
      const reissued = await dbGet<TransferRow>(
        sql,
        `UPDATE account_deletion_transfers
            SET handoff_token_hash = $2, handoff_expires_at = $3, updated_at = $4
          WHERE id = $1 AND phase = 'pending_successor'
            AND handoff_token_hash = $5 AND handoff_expires_at = $6
        RETURNING ${COLUMNS}`,
        [
          existing.id,
          hashToken(raw),
          now + HANDOFF_TOKEN_TTL_MS,
          now,
          existing.handoff_token_hash,
          existing.handoff_expires_at,
        ],
      );
      if (reissued) return ok(c, reissued, raw);

      // Lost the swap — another device already reissued. Report its row.
      const current = await dbGet<TransferRow>(
        sql,
        `SELECT ${COLUMNS} FROM account_deletion_transfers WHERE id = $1`,
        [existing.id],
      );
      return ok(c, current ?? existing, null);
    }
    return ok(c, existing, null);
  }

  const raw = randomBytes(HANDOFF_TOKEN_BYTES).toString('base64url');
  try {
    const created = await dbGet<TransferRow>(
      sql,
      `INSERT INTO account_deletion_transfers
          (id, source_household_id, owner_user_id, handoff_token_hash,
           handoff_expires_at, phase, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'pending_successor', $6, $6)
    RETURNING ${COLUMNS}`,
      [
        nanoid(16),
        membership.household_id,
        userId,
        hashToken(raw),
        now + HANDOFF_TOKEN_TTL_MS,
        now,
      ],
    );
    if (created) return ok(c, created, raw);
  } catch (err: unknown) {
    // Two devices tapped "Delete account" at once — the partial unique
    // index rejected the loser. Resume the winner's transfer.
    if (!isUniqueViolation(err)) throw err;
  }

  const raced = await dbGet<TransferRow>(
    sql,
    `SELECT ${COLUMNS}
       FROM account_deletion_transfers
      WHERE owner_user_id = $1 AND phase <> 'cancelled'
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId],
  );
  if (!raced) {
    return fail(c, 409, 'conflict', 'Could not create a transfer. Reload and try again.');
  }
  return ok(c, raced, null);
});

// ── POST /transfers/:id/inspect — non-consuming handoff inspection ────────

accountDeletionTransferRoutes.post('/transfers/:id/inspect', requireAuth(), async (c) => {
  const body = await parseBody(c, acceptBody);
  if (!body.ok) return fail(c, 400, 'bad_request', body.message);

  const row = await dbGet<TransferRow>(
    getSql(c.env),
    `SELECT ${COLUMNS} FROM account_deletion_transfers WHERE id = $1`,
    [c.req.param('id')],
  );

  // An unknown id and a wrong token are deliberately INDISTINGUISHABLE
  // here. This is the one route a caller can reach holding nothing but a
  // link, so a 404-vs-403 split would turn it into an oracle for which
  // transfer ids exist. Every other route can afford to 404 because it
  // already required an authenticated party.
  if (!row || !tokenMatches(body.data.token, row.handoff_token_hash)) {
    return fail(c, 403, 'invalid_token', 'Handoff token is not valid for this transfer.');
  }
  if (row.handoff_expires_at <= Date.now()) {
    return fail(c, 403, 'handoff_expired', 'This handoff link has expired.');
  }

  return c.json({
    ok: true,
    data: {
      transfer_id: row.id,
      source_household_id: row.source_household_id,
      phase: row.phase,
      handoff_expires_at: row.handoff_expires_at,
    },
  });
});

// ── POST /transfers/:id/handoff-token — explicit owner rotation ───────────

accountDeletionTransferRoutes.post('/transfers/:id/handoff-token', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const raw = randomBytes(HANDOFF_TOKEN_BYTES).toString('base64url');
  const now = Date.now();

  const outcome = await withParty(getSql(c.env), id, userId, 'owner', async (tx, row) => {
    if (row.phase !== 'pending_successor') return PHASE_CONFLICT(row);
    const updated = await transition(
      tx,
      id,
      ['pending_successor'],
      `handoff_token_hash = $3, handoff_expires_at = $4, updated_at = $5`,
      [hashToken(raw), now + HANDOFF_TOKEN_TTL_MS, now],
    );
    if (!updated) return PHASE_CONFLICT(row);
    return { kind: 'ok', row: updated } as const;
  });

  if (outcome.kind === 'error') {
    return fail(c, outcome.status, outcome.code, outcome.message, outcome.phase);
  }
  return ok(c, outcome.row, raw);
});

// ── POST /transfers/:id/accept — bind the successor ───────────────────────

/**
 * The successor presents the handoff token after their app has proved it
 * can read the source shared zone. That share-access proof is the only
 * possible participant check: participants are invisible to the server's
 * membership table, so the server verifies the token, the identity, and
 * that the successor is not the owner — nothing else.
 *
 * Single use: acceptance is legal only from `pending_successor`, so a
 * replayed link finds a bound row. The bound successor replaying their own
 * accept gets the same state back — the first response may have been lost
 * on the way to their device.
 */
accountDeletionTransferRoutes.post('/transfers/:id/accept', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const sql = getSql(c.env);
  const id = c.req.param('id');

  const body = await parseBody(c, acceptBody);
  if (!body.ok) return fail(c, 400, 'bad_request', body.message);

  const outcome: Outcome = await sql.begin(async (tx) => {
    const row = await lockTransfer(tx, id);
    if (!row) {
      return {
        kind: 'error',
        status: 404,
        code: 'not_found',
        message: 'Transfer not found',
      } as const;
    }

    // Token first — an attacker with a guessed id learns nothing else.
    if (!tokenMatches(body.data.token, row.handoff_token_hash)) {
      return {
        kind: 'error',
        status: 403,
        code: 'invalid_token',
        message: 'Handoff token is not valid for this transfer.',
      } as const;
    }
    if (row.owner_user_id === userId) {
      return {
        kind: 'error',
        status: 403,
        code: 'successor_is_owner',
        message: 'The departing owner cannot be their own successor.',
      } as const;
    }

    if (row.phase !== 'pending_successor') {
      if (row.successor_user_id === userId && row.phase !== 'cancelled') {
        return { kind: 'ok', row } as const; // idempotent replay
      }
      if (row.phase === 'cancelled') {
        return {
          kind: 'error',
          status: 409,
          code: 'phase_conflict',
          message: 'This transfer was cancelled.',
          phase: row.phase,
        } as const;
      }
      return {
        kind: 'error',
        status: 409,
        code: 'already_accepted',
        message: 'This handoff token has already been used.',
        phase: row.phase,
      } as const;
    }

    // Expiry only gates the un-accepted phase; a bound successor replaying
    // later must still be able to read their state back.
    if (row.handoff_expires_at <= Date.now()) {
      return {
        kind: 'error',
        status: 409,
        code: 'token_expired',
        message: 'This handoff link expired. Ask the owner for a new one.',
        phase: row.phase,
      } as const;
    }

    const updated = await transition(
      tx,
      id,
      ['pending_successor'],
      `successor_user_id = $3, phase = 'successor_bound',
       handoff_consumed_at = $4, updated_at = $4`,
      [userId, Date.now()],
    );
    if (!updated) return PHASE_CONFLICT(row);
    return { kind: 'ok', row: updated } as const;
  });

  return respond(c, outcome);
});

// ── PUT /transfers/:id/destination ────────────────────────────────────────

/**
 * The successor posts the zone and share they created and own. Re-posting
 * while still in `destination_ready` is legal — a failed share creation is
 * retried with a fresh share record — but the destination freezes once the
 * owner has verified a copy into it.
 */
accountDeletionTransferRoutes.put('/transfers/:id/destination', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const sql = getSql(c.env);
  const id = c.req.param('id');

  const body = await parseBody(c, destinationBody);
  if (!body.ok) return fail(c, 400, 'bad_request', body.message);

  const outcome = await withParty(sql, id, userId, 'successor', async (tx, row) => {
    if (row.phase !== 'successor_bound' && row.phase !== 'destination_ready') {
      return PHASE_CONFLICT(row);
    }
    const updated = await transition(
      tx,
      id,
      ['successor_bound', 'destination_ready'],
      `destination_zone_name = $3, destination_zone_owner_name = $4,
       destination_share_record_name = $5, destination_share_url = $6,
       phase = 'destination_ready', updated_at = $7`,
      [
        body.data.destination_zone_name,
        body.data.destination_zone_owner_name,
        body.data.destination_share_record_name,
        body.data.destination_share_url ?? null,
        Date.now(),
      ],
    );
    if (!updated) return PHASE_CONFLICT(row);
    return { kind: 'ok', row: updated } as const;
  });

  return respond(c, outcome);
});

// ── PUT /transfers/:id/owner-verification ─────────────────────────────────

/**
 * The departing owner posts the digest and per-type counts it read back
 * from the destination. Re-posting is legal: a copy retry produces a new
 * digest, and the successor's half must match whatever the owner last
 * asserted.
 */
accountDeletionTransferRoutes.put('/transfers/:id/owner-verification', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const sql = getSql(c.env);
  const id = c.req.param('id');

  const body = await parseBody(c, ownerVerificationBody);
  if (!body.ok) return fail(c, 400, 'bad_request', body.message);

  const outcome = await withParty(sql, id, userId, 'owner', async (tx, row) => {
    if (row.phase !== 'destination_ready' && row.phase !== 'owner_verified') {
      return PHASE_CONFLICT(row);
    }
    const now = Date.now();
    const doc: DigestDoc = {
      digest: body.data.digest,
      record_counts: body.data.record_counts,
      submitted_at: now,
    };
    const updated = await transition(
      tx,
      id,
      ['destination_ready', 'owner_verified'],
      `owner_digest = $3, phase = 'owner_verified', updated_at = $4`,
      [doc, now],
    );
    if (!updated) return PHASE_CONFLICT(row);
    return { kind: 'ok', row: updated } as const;
  });

  return respond(c, outcome);
});

// ── PUT /transfers/:id/successor-verification ─────────────────────────────

/**
 * The successor proves it owns the destination and posts its own digest.
 * When the two documents agree the transfer becomes `verified` and server
 * membership is re-homed in the same transaction: the successor becomes an
 * owner of the household whose garden they now host. The membership is
 * upserted, not updated — a CKShare participant usually has no membership
 * row at all until this moment.
 *
 * The departing owner keeps their owner role: "Expiry or decline never
 * changes source ownership", so cancelling after this point must still
 * leave the original garden fully theirs. Their exit is handled by
 * `DELETE /api/me`, which only proceeds from `source_deleted`.
 */
accountDeletionTransferRoutes.put(
  '/transfers/:id/successor-verification',
  requireAuth(),
  async (c) => {
    const userId = c.get('userId');
    const sql = getSql(c.env);
    const id = c.req.param('id');

    const body = await parseBody(c, successorVerificationBody);
    if (!body.ok) return fail(c, 400, 'bad_request', body.message);

    const outcome = await withParty(sql, id, userId, 'successor', async (tx, row) => {
      if (row.phase !== 'owner_verified' && row.phase !== 'verified') {
        return PHASE_CONFLICT(row);
      }

      if (
        body.data.destination_zone_name !== row.destination_zone_name ||
        body.data.destination_zone_owner_name !== row.destination_zone_owner_name
      ) {
        return {
          kind: 'error',
          status: 409,
          code: 'destination_mismatch',
          message: 'Ownership proof does not match the recorded destination zone.',
          phase: row.phase,
        } as const;
      }

      const agrees = digestsAgree(row.owner_digest, body.data);
      const now = Date.now();
      const doc: DigestDoc = {
        digest: body.data.digest,
        record_counts: body.data.record_counts,
        submitted_at: now,
      };

      if (row.phase === 'verified') {
        // Already re-homed. A replay of the same proof reads back; a
        // *different* digest never overwrites the one that authorized it.
        if (!agrees) {
          return {
            kind: 'error',
            status: 409,
            code: 'digest_mismatch',
            message: 'Digest does not match the verified transfer.',
            phase: row.phase,
          } as const;
        }
        return { kind: 'ok', row } as const;
      }

      if (!agrees) {
        // Record the failed attempt so both devices can see the delta on
        // resume, but never advance the phase — the source stays intact.
        const recorded = await transition(
          tx,
          id,
          ['owner_verified'],
          `successor_digest = $3, updated_at = $4`,
          [doc, now],
        );
        return {
          kind: 'error',
          status: 409,
          code: 'digest_mismatch',
          message: 'Copied garden does not match the original. Retry the copy.',
          phase: recorded?.phase ?? row.phase,
        } as const;
      }

      // Remember what the successor's membership was before we touch it:
      // cancellation remains legal until the source-deletion lease, and
      // it has to put this back exactly as it found it.
      const priorRows = await tx.unsafe<{ role: string }[]>(
        `SELECT role FROM memberships WHERE household_id = $1 AND user_id = $2 FOR UPDATE`,
        [row.source_household_id, userId],
      );
      const prior: PriorMembership =
        priorRows[0]?.role === 'owner' ? 'owner' : priorRows[0] ? 'member' : 'absent';

      const updated = await transition(
        tx,
        id,
        ['owner_verified'],
        `successor_digest = $3, successor_prior_membership = $4,
         phase = 'verified', updated_at = $5`,
        [doc, prior, now],
      );
      if (!updated) return PHASE_CONFLICT(row);

      // Atomic re-home: same transaction as the phase flip, so a crash can
      // never leave a verified transfer without an owning successor.
      await tx.unsafe(
        `INSERT INTO memberships (household_id, user_id, role, joined_at)
         VALUES ($1, $2, 'owner', $3)
         ON CONFLICT (household_id, user_id) DO UPDATE SET role = 'owner'`,
        [row.source_household_id, userId, now],
      );

      return { kind: 'ok', row: updated } as const;
    });

    return respond(c, outcome);
  },
);

// ── POST /transfers/:id/source-deleting — acquire deletion lease ──────────

/**
 * The owner atomically closes cancellation before starting irreversible
 * CloudKit deletion. Successor ownership is revalidated under the same
 * transfer lock so no account-deletion request can remove the destination
 * owner between this check and the durable lease.
 */
accountDeletionTransferRoutes.post('/transfers/:id/source-deleting', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const sql = getSql(c.env);
  const id = c.req.param('id');

  const outcome = await withParty(sql, id, userId, 'owner', async (tx, row) => {
    if (row.phase === 'source_deleting' || row.phase === 'source_deleted') {
      return { kind: 'ok', row } as const;
    }
    if (row.phase !== 'verified') return PHASE_CONFLICT(row);

    if (!(await successorOwnsSource(tx, row))) {
      return {
        kind: 'error',
        status: 409,
        code: 'successor_unavailable',
        message:
          'The successor no longer owns the transferred garden. Cancel this transfer and start a new handoff.',
        phase: row.phase,
      } as const;
    }

    const now = Date.now();
    const updated = await transition(
      tx,
      id,
      ['verified'],
      `phase = 'source_deleting', source_deleting_at = $3, updated_at = $3`,
      [now],
    );
    if (!updated) return PHASE_CONFLICT(row);
    return { kind: 'ok', row: updated } as const;
  });

  return respond(c, outcome);
});

// ── POST /transfers/:id/source-deleted ────────────────────────────────────

/**
 * The owner reports the source zone verifiably absent. Unlocks
 * `DELETE /api/me`.
 *
 * The bound successor must still exist and still own the household. The
 * same invariant was checked when the lease was acquired, and is checked
 * again here before the durable transfer authorizes final account deletion.
 */
accountDeletionTransferRoutes.post('/transfers/:id/source-deleted', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const sql = getSql(c.env);
  const id = c.req.param('id');

  const outcome = await withParty(sql, id, userId, 'owner', async (tx, row) => {
    if (row.phase === 'source_deleted') return { kind: 'ok', row } as const;
    if (row.phase !== 'source_deleting') return PHASE_CONFLICT(row);

    if (!(await successorOwnsSource(tx, row))) {
      return {
        kind: 'error',
        status: 409,
        code: 'successor_unavailable',
        message: 'The successor no longer owns the transferred garden.',
        phase: row.phase,
      } as const;
    }

    const updated = await transition(
      tx,
      id,
      ['source_deleting'],
      `phase = 'source_deleted', updated_at = $3`,
      [Date.now()],
    );
    if (!updated) return PHASE_CONFLICT(row);
    return { kind: 'ok', row: updated } as const;
  });

  return respond(c, outcome);
});

// ── GET /transfers/:id — resume ───────────────────────────────────────────

/** Either bound party reloads the durable phase after a crash or restart. */
accountDeletionTransferRoutes.get('/transfers/:id', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const sql = getSql(c.env);
  const id = c.req.param('id');

  const outcome = await withParty(
    sql,
    id,
    userId,
    'either',
    async (_tx, row) => ({ kind: 'ok', row }) as const,
  );
  return respond(c, outcome);
});

// ── DELETE /transfers/:id — cancel ────────────────────────────────────────

/**
 * The owner abandons the handoff. Legal only before the source-deletion
 * lease; once irreversible deletion may have started, the durable transfer
 * cannot be withdrawn.
 *
 * Cancelling never touches garden data, and it must not leave server
 * authority behind either: if verification already re-homed membership
 * ownership, the successor's membership is restored to exactly what it
 * was before the handoff — removed when the transfer created it, demoted
 * when it promoted an existing member, untouched when they were already
 * an owner.
 */
accountDeletionTransferRoutes.delete('/transfers/:id', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const sql = getSql(c.env);
  const id = c.req.param('id');

  const outcome = await withParty(sql, id, userId, 'owner', async (tx, row) => {
    if (row.phase === 'cancelled') return { kind: 'ok', row } as const;
    if (row.phase === 'source_deleting' || row.phase === 'source_deleted') {
      return PHASE_CONFLICT(row);
    }

    const now = Date.now();
    const updated = await transition(
      tx,
      id,
      TRANSFER_PHASES.filter(
        (p) => p !== 'cancelled' && p !== 'source_deleting' && p !== 'source_deleted',
      ),
      `phase = 'cancelled', cancelled_at = $3, updated_at = $3`,
      [now],
    );
    if (!updated) return PHASE_CONFLICT(row);

    // `successor_prior_membership` is written only by the re-home, so its
    // presence is the marker that there is something to undo.
    if (row.successor_user_id !== null && row.successor_prior_membership !== null) {
      const params = [row.source_household_id, row.successor_user_id];
      if (row.successor_prior_membership === 'absent') {
        await tx.unsafe(
          `DELETE FROM memberships
            WHERE household_id = $1 AND user_id = $2 AND role = 'owner'`,
          params,
        );
      } else if (row.successor_prior_membership === 'member') {
        await tx.unsafe(
          `UPDATE memberships SET role = 'member'
            WHERE household_id = $1 AND user_id = $2 AND role = 'owner'`,
          params,
        );
      }
    }

    return { kind: 'ok', row: updated } as const;
  });

  return respond(c, outcome);
});
