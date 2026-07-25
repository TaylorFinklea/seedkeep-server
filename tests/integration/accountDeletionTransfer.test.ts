/**
 * Task 1 · integration tests for the CloudKit account-deletion transfer
 * state machine.
 *
 * Spec: seedkeep/.docs/ai/phases/2026-07-23-cloudkit-account-deletion-spec.md
 *
 * The server coordinates a shared-garden owner and a successor across two
 * devices without ever receiving garden contents. These tests pin every
 * authorization rule and every legal/illegal phase transition:
 *
 *   pending_successor → successor_bound → destination_ready
 *     → owner_verified → verified → source_deleted
 *   (any non-terminal phase) → cancelled
 *
 * Also covers: 256-bit handoff token stored only as a SHA-256 hash, 72h
 * expiry, single use, create/accept/advance idempotency, digest and
 * per-type count equality before `verified`, atomic membership re-home,
 * and the `DELETE /api/me` CloudKit disposition gate that keeps
 * credentials alive until the source zone is provably gone.
 *
 * CloudKit roles are invisible to this server — CKShare participants are
 * not `memberships` rows — so nothing here may be inferred from member
 * counts. Several tests exist specifically to hold that line.
 *
 * Run with:
 *   bun test tests/integration/accountDeletionTransfer.test.ts
 *
 * Prerequisites:
 *   - Local Postgres reachable at DATABASE_URL
 *   - Migrations 0001–0025 applied (`bun run migrate`)
 */

import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import postgres, { type Sql } from 'postgres';
import { createHash } from 'node:crypto';
import { createApp } from '../../src/index';
import type { Env } from '../../src/env';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://seedkeep:dev-only@localhost:5432/seedkeep';

const sql: Sql = postgres(DATABASE_URL, {
  transform: { undefined: null },
  onnotice: () => { /* silence */ },
  types: {
    bigint: {
      to: 20,
      from: [20],
      serialize: (x: number | bigint) => String(x),
      parse: (x: string) => Number(x),
    },
  },
});

// One scenario reaches the sole-member hard delete; stub storage so no
// test ever talks to S3.
const deletedKeys: string[] = [];
mock.module('../../src/lib/storage', () => ({
  deletePhoto: async (_env: unknown, key: string) => {
    deletedKeys.push(key);
  },
  putPhoto: async () => {},
  getPhoto: async () => null,
  newPhotoKey: () => 'mocked-key',
  isAllowedMime: () => true,
}));

const TEST_MASTER_KEY = Buffer.from('test-master-key-for-deletion-transfer-1').toString('base64');

const TEST_ENV: Env = {
  PORT: 8787,
  APP_ENV: 'development',
  DATABASE_URL,
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
  S3_BUCKET: 'test-bucket',
  S3_FORCE_PATH_STYLE: false,
  BETTER_AUTH_SECRET: 'test-better-auth-secret-1234567890',
  APPLE_CLIENT_ID: 'test-apple-client',
  APPLE_CLIENT_SECRET: 'test-apple-secret',
  ANTHROPIC_API_KEY: undefined,
  APPLE_IAP_SHARED_SECRET: undefined,
  ASSISTANT_KEY_MASTER: TEST_MASTER_KEY,
  DEFAULT_VISION_MODEL: 'claude-sonnet-4-6',
  DEFAULT_REVIEW_MODEL: 'claude-haiku-4-5-20251001',
  ADMIN_SECRET: 'test-admin-secret-please',
  GARDEN_TOOLS_ENABLED: true,
};

const app = createApp(TEST_ENV);

const BASE = '/api/account-deletion/transfers';
const HANDOFF_TTL_MS = 72 * 60 * 60 * 1000;

// ── Wire shapes ───────────────────────────────────────────────────────────

interface DigestDoc {
  digest: string;
  record_counts: Record<string, number>;
  submitted_at: number;
}

interface TransferWire {
  id: string;
  source_household_id: string;
  owner_user_id: string;
  successor_user_id: string | null;
  phase: string;
  handoff_expires_at: number;
  handoff_consumed_at: number | null;
  destination_zone_name: string | null;
  destination_zone_owner_name: string | null;
  destination_share_record_name: string | null;
  destination_share_url: string | null;
  owner_digest: DigestDoc | null;
  successor_digest: DigestDoc | null;
  created_at: number;
  updated_at: number;
  cancelled_at: number | null;
}

interface OkBody {
  ok: true;
  data: { transfer: TransferWire; handoff_token?: string | null };
}

interface ErrBody {
  ok: false;
  error: { code: string; message: string; phase?: string };
}

type AnyBody = OkBody | ErrBody;

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: AnyBody }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await app.request(
    path,
    {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    },
    TEST_ENV,
  );
  const body = (await res.json()) as AnyBody;
  return { status: res.status, body };
}

function okBody(body: AnyBody): OkBody {
  if (!body.ok) throw new Error(`expected ok envelope, got ${JSON.stringify(body)}`);
  return body;
}

function errBody(body: AnyBody): ErrBody {
  if (body.ok) throw new Error(`expected error envelope, got ${JSON.stringify(body)}`);
  return body;
}

// ── Fixtures ──────────────────────────────────────────────────────────────

function uid(prefix: string): string {
  return `adt-${prefix}-${Math.random().toString(36).slice(2, 12)}`;
}

interface Party {
  userId: string;
  sessionToken: string;
}

interface Scene {
  householdId: string;
  owner: Party;
  /** A server member of the household. */
  successor: Party;
  /** Another server member, never bound to the transfer. */
  bystander: Party;
  /** Authenticated, but no membership anywhere — like a CKShare participant. */
  outsider: Party;
}

async function seedUser(): Promise<Party> {
  const userId = uid('user');
  const sessionId = uid('sess');
  const sessionToken = uid('tok');
  const now = Date.now();

  await sql.unsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'Transfer User', $2, TRUE,
             to_timestamp($3 / 1000.0), to_timestamp($3 / 1000.0))`,
    [userId, `${userId}@example.invalid`, now],
  );
  await sql.unsafe(
    `INSERT INTO session (id, "expiresAt", token, "createdAt", "updatedAt",
                          "ipAddress", "userAgent", "userId")
     VALUES ($1, NOW() + INTERVAL '1 day', $2, NOW(), NOW(), NULL, NULL, $3)`,
    [sessionId, sessionToken, userId],
  );
  return { userId, sessionToken };
}

async function seedHousehold(): Promise<string> {
  const householdId = uid('hh');
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO households (id, name, created_at, updated_at)
     VALUES ($1, 'Transfer Household', $2, $2)`,
    [householdId, now],
  );
  return householdId;
}

async function addMembership(
  householdId: string,
  userId: string,
  role: 'owner' | 'member',
  joinedAtOffset = 0,
): Promise<void> {
  await sql.unsafe(
    `INSERT INTO memberships (household_id, user_id, role, joined_at)
     VALUES ($1, $2, $3, $4)`,
    [householdId, userId, role, Date.now() + joinedAtOffset],
  );
}

async function seedScene(): Promise<Scene> {
  const [owner, successor, bystander, outsider] = await Promise.all([
    seedUser(),
    seedUser(),
    seedUser(),
    seedUser(),
  ]);
  const householdId = await seedHousehold();
  await addMembership(householdId, owner.userId, 'owner', 0);
  await addMembership(householdId, successor.userId, 'member', 1000);
  await addMembership(householdId, bystander.userId, 'member', 2000);
  return { householdId, owner, successor, bystander, outsider };
}

async function roleOf(householdId: string, userId: string): Promise<string | null> {
  const rows = await sql.unsafe<{ role: string }[]>(
    `SELECT role FROM memberships WHERE household_id = $1 AND user_id = $2`,
    [householdId, userId],
  );
  return rows[0]?.role ?? null;
}

async function phaseOf(transferId: string): Promise<string | null> {
  const rows = await sql.unsafe<{ phase: string }[]>(
    `SELECT phase FROM account_deletion_transfers WHERE id = $1`,
    [transferId],
  );
  return rows[0]?.phase ?? null;
}

async function transferRow(transferId: string): Promise<Record<string, unknown> | null> {
  const rows = await sql.unsafe<Record<string, unknown>[]>(
    `SELECT * FROM account_deletion_transfers WHERE id = $1`,
    [transferId],
  );
  return rows[0] ?? null;
}

// ── Canonical payloads ────────────────────────────────────────────────────

const DIGEST_MATCH = 'a3f1'.repeat(16); // 64 hex chars
const DIGEST_OTHER = 'b7c2'.repeat(16);

const COUNTS: Record<string, number> = { Seed: 12, Bed: 3, PlantingEvent: 41 };

const DESTINATION = {
  destination_zone_name: 'household-successor-zone',
  destination_zone_owner_name: '_9a7f1c0e3b5d2a48successorrecord',
  destination_share_record_name: 'share-successor-1',
  destination_share_url: 'https://www.icloud.com/share/0Adestination',
};

type Phase =
  | 'pending_successor'
  | 'successor_bound'
  | 'destination_ready'
  | 'owner_verified'
  | 'verified'
  | 'source_deleted';

/** Drive the machine to a phase, returning the transfer id + raw token. */
async function driveTo(
  scene: Scene,
  target: Phase,
  successor: Party = scene.successor,
): Promise<{ id: string; token: string }> {
  const created = await api('POST', BASE, { token: scene.owner.sessionToken });
  expect(created.status).toBe(200);
  const createdBody = okBody(created.body);
  const id = createdBody.data.transfer.id;
  const token = createdBody.data.handoff_token as string;
  if (target === 'pending_successor') return { id, token };

  const accepted = await api('POST', `${BASE}/${id}/accept`, {
    token: successor.sessionToken,
    body: { token },
  });
  expect(accepted.status).toBe(200);
  if (target === 'successor_bound') return { id, token };

  const dest = await api('PUT', `${BASE}/${id}/destination`, {
    token: successor.sessionToken,
    body: DESTINATION,
  });
  expect(dest.status).toBe(200);
  if (target === 'destination_ready') return { id, token };

  const ownerVerify = await api('PUT', `${BASE}/${id}/owner-verification`, {
    token: scene.owner.sessionToken,
    body: { digest: DIGEST_MATCH, record_counts: COUNTS },
  });
  expect(ownerVerify.status).toBe(200);
  if (target === 'owner_verified') return { id, token };

  const successorVerify = await api('PUT', `${BASE}/${id}/successor-verification`, {
    token: successor.sessionToken,
    body: {
      digest: DIGEST_MATCH,
      record_counts: COUNTS,
      destination_zone_name: DESTINATION.destination_zone_name,
      destination_zone_owner_name: DESTINATION.destination_zone_owner_name,
    },
  });
  expect(successorVerify.status).toBe(200);
  if (target === 'verified') return { id, token };

  const sourceDeleted = await api('POST', `${BASE}/${id}/source-deleted`, {
    token: scene.owner.sessionToken,
  });
  expect(sourceDeleted.status).toBe(200);
  return { id, token };
}

beforeAll(async () => {
  await sql`SELECT 1`;
  deletedKeys.length = 0;
});

afterAll(async () => {
  // User deletion cascades memberships and transfers.
  await sql.unsafe(`DELETE FROM "user" WHERE id LIKE 'adt-user-%'`).catch(() => {});
  await sql.unsafe(`DELETE FROM households WHERE id LIKE 'adt-hh-%'`).catch(() => {});
  await sql.end({ timeout: 5 });
});

// ── Create / resume ───────────────────────────────────────────────────────

describe('POST /api/account-deletion/transfers', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await api('POST', BASE);
    expect(res.status).toBe(401);
    expect(errBody(res.body).error.code).toBe('unauthorized');
  });

  it('creates a pending transfer and stores only the token hash', async () => {
    const scene = await seedScene();
    const before = Date.now();

    const res = await api('POST', BASE, { token: scene.owner.sessionToken });
    expect(res.status).toBe(200);
    const { transfer, handoff_token: token } = okBody(res.body).data;

    expect(transfer.phase).toBe('pending_successor');
    expect(transfer.owner_user_id).toBe(scene.owner.userId);
    expect(transfer.source_household_id).toBe(scene.householdId);
    expect(transfer.successor_user_id).toBeNull();
    expect(transfer.handoff_consumed_at).toBeNull();

    // 256-bit random, base64url encoded.
    expect(typeof token).toBe('string');
    expect((token as string).length).toBeGreaterThanOrEqual(43);
    expect(token as string).toMatch(/^[A-Za-z0-9_-]+$/);

    // 72h expiry.
    expect(transfer.handoff_expires_at).toBeGreaterThanOrEqual(before + HANDOFF_TTL_MS - 5000);
    expect(transfer.handoff_expires_at).toBeLessThanOrEqual(Date.now() + HANDOFF_TTL_MS + 5000);

    // The raw token never lands in the database; only its SHA-256 hash.
    const row = (await transferRow(transfer.id))!;
    expect(row.handoff_token_hash).toBe(
      createHash('sha256').update(token as string, 'utf8').digest('hex'),
    );
    expect(JSON.stringify(row)).not.toContain(token as string);
  });

  it('does not gate on member counts — CKShare participants are invisible here', async () => {
    // A household with a single membership row can still be a shared
    // CloudKit garden, and a co-owned household can still need a handoff.
    const solo = await seedUser();
    const soloHousehold = await seedHousehold();
    await addMembership(soloHousehold, solo.userId, 'owner');
    const soloRes = await api('POST', BASE, { token: solo.sessionToken });
    expect(soloRes.status).toBe(200);
    expect(okBody(soloRes.body).data.transfer.phase).toBe('pending_successor');

    const scene = await seedScene();
    await sql.unsafe(
      `UPDATE memberships SET role = 'owner' WHERE household_id = $1 AND user_id = $2`,
      [scene.householdId, scene.bystander.userId],
    );
    const coOwned = await api('POST', BASE, { token: scene.owner.sessionToken });
    expect(coOwned.status).toBe(200);
    expect(okBody(coOwned.body).data.transfer.phase).toBe('pending_successor');
  });

  it('refuses a non-owner member of the household', async () => {
    const scene = await seedScene();
    const res = await api('POST', BASE, { token: scene.successor.sessionToken });
    expect(res.status).toBe(403);
    expect(errBody(res.body).error.code).toBe('forbidden');
  });

  it('refuses a caller with no household', async () => {
    const scene = await seedScene();
    const res = await api('POST', BASE, { token: scene.outsider.sessionToken });
    expect(res.status).toBe(403);
    expect(errBody(res.body).error.code).toBe('forbidden');
  });

  it('resumes the existing transfer instead of creating a second one', async () => {
    const scene = await seedScene();
    const first = await api('POST', BASE, { token: scene.owner.sessionToken });
    const firstBody = okBody(first.body);

    const second = await api('POST', BASE, { token: scene.owner.sessionToken });
    expect(second.status).toBe(200);
    const secondBody = okBody(second.body);

    expect(secondBody.data.transfer.id).toBe(firstBody.data.transfer.id);
    expect(secondBody.data.transfer.phase).toBe('pending_successor');
    expect(secondBody.data.transfer.created_at).toBe(firstBody.data.transfer.created_at);
    // A live token is unrecoverable — resume never re-issues it.
    expect(secondBody.data.handoff_token).toBeNull();

    const rows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM account_deletion_transfers WHERE owner_user_id = $1`,
      [scene.owner.userId],
    );
    expect(rows.length).toBe(1);
  });

  it('mints a fresh token when the previous handoff token expired', async () => {
    const scene = await seedScene();
    const first = await api('POST', BASE, { token: scene.owner.sessionToken });
    const firstBody = okBody(first.body);
    const staleToken = firstBody.data.handoff_token as string;

    await sql.unsafe(
      `UPDATE account_deletion_transfers SET handoff_expires_at = $1 WHERE id = $2`,
      [Date.now() - 1000, firstBody.data.transfer.id],
    );

    const resumed = await api('POST', BASE, { token: scene.owner.sessionToken });
    const resumedBody = okBody(resumed.body);
    const freshToken = resumedBody.data.handoff_token as string;

    expect(resumedBody.data.transfer.id).toBe(firstBody.data.transfer.id);
    expect(typeof freshToken).toBe('string');
    expect(freshToken).not.toBe(staleToken);
    expect(resumedBody.data.transfer.handoff_expires_at).toBeGreaterThan(Date.now());

    // The expired token is dead; the reissued one works.
    const stale = await api('POST', `${BASE}/${firstBody.data.transfer.id}/accept`, {
      token: scene.successor.sessionToken,
      body: { token: staleToken },
    });
    expect(stale.status).toBe(403);
    expect(errBody(stale.body).error.code).toBe('invalid_token');

    const fresh = await api('POST', `${BASE}/${firstBody.data.transfer.id}/accept`, {
      token: scene.successor.sessionToken,
      body: { token: freshToken },
    });
    expect(fresh.status).toBe(200);
  });

  it('enforces one active transfer per owner at the database level', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'pending_successor');
    const now = Date.now();

    // postgres.js queries are lazy thenables, so drive the rejection by
    // hand and pin the exact constraint that fired.
    let violation: { code?: string } | null = null;
    try {
      await sql.unsafe(
        `INSERT INTO account_deletion_transfers
           (id, source_household_id, owner_user_id, handoff_token_hash,
            handoff_expires_at, phase, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'pending_successor', $6, $6)`,
        [uid('dup'), scene.householdId, scene.owner.userId, `hash-${now}`, now + 1000, now],
      );
    } catch (err: unknown) {
      violation = err as { code?: string };
    }
    expect(violation?.code).toBe('23505');

    expect(await phaseOf(id)).toBe('pending_successor');
  });
});

// ── Accept ────────────────────────────────────────────────────────────────

describe('POST /api/account-deletion/transfers/:id/accept', () => {
  it('binds the successor and consumes the token', async () => {
    const scene = await seedScene();
    const { id, token } = await driveTo(scene, 'pending_successor');

    const res = await api('POST', `${BASE}/${id}/accept`, {
      token: scene.successor.sessionToken,
      body: { token },
    });
    expect(res.status).toBe(200);
    const { transfer } = okBody(res.body).data;
    expect(transfer.phase).toBe('successor_bound');
    expect(transfer.successor_user_id).toBe(scene.successor.userId);
    expect(transfer.handoff_consumed_at).not.toBeNull();
  });

  it('binds a CKShare participant who has no server membership', async () => {
    const scene = await seedScene();
    const { id, token } = await driveTo(scene, 'pending_successor');

    const res = await api('POST', `${BASE}/${id}/accept`, {
      token: scene.outsider.sessionToken,
      body: { token },
    });
    expect(res.status).toBe(200);
    expect(okBody(res.body).data.transfer.successor_user_id).toBe(scene.outsider.userId);
    expect(await roleOf(scene.householdId, scene.outsider.userId)).toBeNull();
  });

  it('rejects an unknown transfer id', async () => {
    const scene = await seedScene();
    const res = await api('POST', `${BASE}/does-not-exist/accept`, {
      token: scene.successor.sessionToken,
      body: { token: 'whatever' },
    });
    expect(res.status).toBe(404);
    expect(errBody(res.body).error.code).toBe('not_found');
  });

  it('rejects a wrong token without changing phase', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'pending_successor');

    const res = await api('POST', `${BASE}/${id}/accept`, {
      token: scene.successor.sessionToken,
      body: { token: 'not-the-real-token' },
    });
    expect(res.status).toBe(403);
    expect(errBody(res.body).error.code).toBe('invalid_token');
    expect(await phaseOf(id)).toBe('pending_successor');
  });

  it('rejects an expired token without changing phase', async () => {
    const scene = await seedScene();
    const { id, token } = await driveTo(scene, 'pending_successor');
    await sql.unsafe(
      `UPDATE account_deletion_transfers SET handoff_expires_at = $1 WHERE id = $2`,
      [Date.now() - 1, id],
    );

    const res = await api('POST', `${BASE}/${id}/accept`, {
      token: scene.successor.sessionToken,
      body: { token },
    });
    expect(res.status).toBe(409);
    expect(errBody(res.body).error.code).toBe('token_expired');
    expect(await phaseOf(id)).toBe('pending_successor');
  });

  it('refuses the owner accepting their own handoff', async () => {
    const scene = await seedScene();
    const { id, token } = await driveTo(scene, 'pending_successor');

    const res = await api('POST', `${BASE}/${id}/accept`, {
      token: scene.owner.sessionToken,
      body: { token },
    });
    expect(res.status).toBe(403);
    expect(errBody(res.body).error.code).toBe('successor_is_owner');
    expect(await phaseOf(id)).toBe('pending_successor');
  });

  it('is idempotent when the bound successor retries with the same token', async () => {
    const scene = await seedScene();
    const { id, token } = await driveTo(scene, 'pending_successor');

    const first = await api('POST', `${BASE}/${id}/accept`, {
      token: scene.successor.sessionToken,
      body: { token },
    });
    const consumedAt = okBody(first.body).data.transfer.handoff_consumed_at;

    const retry = await api('POST', `${BASE}/${id}/accept`, {
      token: scene.successor.sessionToken,
      body: { token },
    });
    expect(retry.status).toBe(200);
    const { transfer } = okBody(retry.body).data;
    expect(transfer.phase).toBe('successor_bound');
    expect(transfer.successor_user_id).toBe(scene.successor.userId);
    expect(transfer.handoff_consumed_at).toBe(consumedAt);
  });

  it('is single-use — a second account cannot reuse a consumed token', async () => {
    const scene = await seedScene();
    const { id, token } = await driveTo(scene, 'successor_bound');

    const res = await api('POST', `${BASE}/${id}/accept`, {
      token: scene.bystander.sessionToken,
      body: { token },
    });
    expect(res.status).toBe(409);
    expect(errBody(res.body).error.code).toBe('already_accepted');

    const row = (await transferRow(id))!;
    expect(row.successor_user_id).toBe(scene.successor.userId);
  });

  it('refuses acceptance of a cancelled transfer', async () => {
    const scene = await seedScene();
    const { id, token } = await driveTo(scene, 'pending_successor');
    await api('DELETE', `${BASE}/${id}`, { token: scene.owner.sessionToken });

    const res = await api('POST', `${BASE}/${id}/accept`, {
      token: scene.successor.sessionToken,
      body: { token },
    });
    expect(res.status).toBe(409);
    expect(errBody(res.body).error.code).toBe('phase_conflict');
    expect(await phaseOf(id)).toBe('cancelled');
  });
});

// ── Destination ───────────────────────────────────────────────────────────

describe('PUT /api/account-deletion/transfers/:id/destination', () => {
  it('records successor-owned destination identifiers', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'successor_bound');

    const res = await api('PUT', `${BASE}/${id}/destination`, {
      token: scene.successor.sessionToken,
      body: DESTINATION,
    });
    expect(res.status).toBe(200);
    const { transfer } = okBody(res.body).data;
    expect(transfer.phase).toBe('destination_ready');
    expect(transfer.destination_zone_name).toBe(DESTINATION.destination_zone_name);
    expect(transfer.destination_zone_owner_name).toBe(DESTINATION.destination_zone_owner_name);
    expect(transfer.destination_share_record_name).toBe(DESTINATION.destination_share_record_name);
    expect(transfer.destination_share_url).toBe(DESTINATION.destination_share_url);
  });

  it('refuses the departing owner', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'successor_bound');

    const res = await api('PUT', `${BASE}/${id}/destination`, {
      token: scene.owner.sessionToken,
      body: DESTINATION,
    });
    expect(res.status).toBe(403);
    expect(errBody(res.body).error.code).toBe('forbidden');
    expect(await phaseOf(id)).toBe('successor_bound');
  });

  it('refuses submission before a successor is bound', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'pending_successor');

    const res = await api('PUT', `${BASE}/${id}/destination`, {
      token: scene.successor.sessionToken,
      body: DESTINATION,
    });
    expect(res.status).toBe(403);
    expect(errBody(res.body).error.code).toBe('forbidden');
  });

  it('rejects a malformed body', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'successor_bound');

    const res = await api('PUT', `${BASE}/${id}/destination`, {
      token: scene.successor.sessionToken,
      body: { destination_zone_name: '' },
    });
    expect(res.status).toBe(400);
    expect(errBody(res.body).error.code).toBe('bad_request');
    expect(await phaseOf(id)).toBe('successor_bound');
  });

  it('accepts a retry that replaces the destination share after a failed attempt', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'destination_ready');

    const retry = await api('PUT', `${BASE}/${id}/destination`, {
      token: scene.successor.sessionToken,
      body: { ...DESTINATION, destination_share_record_name: 'share-successor-2' },
    });
    expect(retry.status).toBe(200);
    const { transfer } = okBody(retry.body).data;
    expect(transfer.phase).toBe('destination_ready');
    expect(transfer.destination_share_record_name).toBe('share-successor-2');
  });

  it('refuses destination changes once the owner has verified', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'owner_verified');

    const res = await api('PUT', `${BASE}/${id}/destination`, {
      token: scene.successor.sessionToken,
      body: { ...DESTINATION, destination_zone_name: 'other-zone' },
    });
    expect(res.status).toBe(409);
    const err = errBody(res.body).error;
    expect(err.code).toBe('phase_conflict');
    expect(err.phase).toBe('owner_verified');
  });
});

// ── Owner verification ────────────────────────────────────────────────────

describe('PUT /api/account-deletion/transfers/:id/owner-verification', () => {
  it('stores the owner digest and per-type counts', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'destination_ready');

    const res = await api('PUT', `${BASE}/${id}/owner-verification`, {
      token: scene.owner.sessionToken,
      body: { digest: DIGEST_MATCH, record_counts: COUNTS },
    });
    expect(res.status).toBe(200);
    const { transfer } = okBody(res.body).data;
    expect(transfer.phase).toBe('owner_verified');
    expect(transfer.owner_digest?.digest).toBe(DIGEST_MATCH);
    expect(transfer.owner_digest?.record_counts).toEqual(COUNTS);
    expect(transfer.successor_digest).toBeNull();
  });

  it('refuses the successor', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'destination_ready');

    const res = await api('PUT', `${BASE}/${id}/owner-verification`, {
      token: scene.successor.sessionToken,
      body: { digest: DIGEST_MATCH, record_counts: COUNTS },
    });
    expect(res.status).toBe(403);
    expect(errBody(res.body).error.code).toBe('forbidden');
    expect(await phaseOf(id)).toBe('destination_ready');
  });

  it('refuses verification before the destination exists', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'successor_bound');

    const res = await api('PUT', `${BASE}/${id}/owner-verification`, {
      token: scene.owner.sessionToken,
      body: { digest: DIGEST_MATCH, record_counts: COUNTS },
    });
    expect(res.status).toBe(409);
    const err = errBody(res.body).error;
    expect(err.code).toBe('phase_conflict');
    expect(err.phase).toBe('successor_bound');
  });

  it('rejects a non-hex digest', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'destination_ready');

    const res = await api('PUT', `${BASE}/${id}/owner-verification`, {
      token: scene.owner.sessionToken,
      body: { digest: 'not-a-digest', record_counts: COUNTS },
    });
    expect(res.status).toBe(400);
    expect(errBody(res.body).error.code).toBe('bad_request');
    expect(await phaseOf(id)).toBe('destination_ready');
  });

  it('accepts a re-verification after a copy retry', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'owner_verified');

    const retry = await api('PUT', `${BASE}/${id}/owner-verification`, {
      token: scene.owner.sessionToken,
      body: { digest: DIGEST_OTHER, record_counts: { ...COUNTS, Seed: 13 } },
    });
    expect(retry.status).toBe(200);
    const { transfer } = okBody(retry.body).data;
    expect(transfer.phase).toBe('owner_verified');
    expect(transfer.owner_digest?.digest).toBe(DIGEST_OTHER);
    expect(transfer.owner_digest?.record_counts.Seed).toBe(13);
  });
});

// ── Successor verification + membership re-home ───────────────────────────

describe('PUT /api/account-deletion/transfers/:id/successor-verification', () => {
  it('marks the transfer verified and re-homes membership ownership', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'owner_verified');

    const res = await api('PUT', `${BASE}/${id}/successor-verification`, {
      token: scene.successor.sessionToken,
      body: {
        digest: DIGEST_MATCH,
        record_counts: COUNTS,
        destination_zone_name: DESTINATION.destination_zone_name,
        destination_zone_owner_name: DESTINATION.destination_zone_owner_name,
      },
    });
    expect(res.status).toBe(200);
    const { transfer } = okBody(res.body).data;
    expect(transfer.phase).toBe('verified');
    expect(transfer.successor_digest?.digest).toBe(DIGEST_MATCH);

    expect(await roleOf(scene.householdId, scene.successor.userId)).toBe('owner');
    // Source ownership is never taken away — cancellation must stay safe.
    expect(await roleOf(scene.householdId, scene.owner.userId)).toBe('owner');
    expect(await roleOf(scene.householdId, scene.bystander.userId)).toBe('member');
  });

  it('creates the membership when the successor had none', async () => {
    const scene = await seedScene();
    await driveTo(scene, 'verified', scene.outsider);
    expect(await roleOf(scene.householdId, scene.outsider.userId)).toBe('owner');
  });

  it('refuses the owner', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'owner_verified');

    const res = await api('PUT', `${BASE}/${id}/successor-verification`, {
      token: scene.owner.sessionToken,
      body: {
        digest: DIGEST_MATCH,
        record_counts: COUNTS,
        destination_zone_name: DESTINATION.destination_zone_name,
        destination_zone_owner_name: DESTINATION.destination_zone_owner_name,
      },
    });
    expect(res.status).toBe(403);
    expect(errBody(res.body).error.code).toBe('forbidden');
    expect(await phaseOf(id)).toBe('owner_verified');
  });

  it('refuses verification before the owner has verified', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'destination_ready');

    const res = await api('PUT', `${BASE}/${id}/successor-verification`, {
      token: scene.successor.sessionToken,
      body: {
        digest: DIGEST_MATCH,
        record_counts: COUNTS,
        destination_zone_name: DESTINATION.destination_zone_name,
        destination_zone_owner_name: DESTINATION.destination_zone_owner_name,
      },
    });
    expect(res.status).toBe(409);
    expect(errBody(res.body).error.phase).toBe('destination_ready');
    expect(await roleOf(scene.householdId, scene.successor.userId)).toBe('member');
  });

  it('refuses a digest mismatch and leaves membership untouched', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'owner_verified');

    const res = await api('PUT', `${BASE}/${id}/successor-verification`, {
      token: scene.successor.sessionToken,
      body: {
        digest: DIGEST_OTHER,
        record_counts: COUNTS,
        destination_zone_name: DESTINATION.destination_zone_name,
        destination_zone_owner_name: DESTINATION.destination_zone_owner_name,
      },
    });
    expect(res.status).toBe(409);
    expect(errBody(res.body).error.code).toBe('digest_mismatch');
    expect(await phaseOf(id)).toBe('owner_verified');
    expect(await roleOf(scene.householdId, scene.successor.userId)).toBe('member');
  });

  it('refuses a per-type count mismatch even when the digest matches', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'owner_verified');

    const res = await api('PUT', `${BASE}/${id}/successor-verification`, {
      token: scene.successor.sessionToken,
      body: {
        digest: DIGEST_MATCH,
        record_counts: { ...COUNTS, Seed: COUNTS.Seed - 1 },
        destination_zone_name: DESTINATION.destination_zone_name,
        destination_zone_owner_name: DESTINATION.destination_zone_owner_name,
      },
    });
    expect(res.status).toBe(409);
    expect(errBody(res.body).error.code).toBe('digest_mismatch');
    expect(await phaseOf(id)).toBe('owner_verified');
    expect(await roleOf(scene.householdId, scene.successor.userId)).toBe('member');
  });

  it('refuses an ownership proof that names a different destination zone', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'owner_verified');

    const res = await api('PUT', `${BASE}/${id}/successor-verification`, {
      token: scene.successor.sessionToken,
      body: {
        digest: DIGEST_MATCH,
        record_counts: COUNTS,
        destination_zone_name: 'some-other-zone',
        destination_zone_owner_name: DESTINATION.destination_zone_owner_name,
      },
    });
    expect(res.status).toBe(409);
    expect(errBody(res.body).error.code).toBe('destination_mismatch');
    expect(await phaseOf(id)).toBe('owner_verified');
    expect(await roleOf(scene.householdId, scene.successor.userId)).toBe('member');
  });

  it('is idempotent on retry — verified stays verified and re-home is not duplicated', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'verified');

    const retry = await api('PUT', `${BASE}/${id}/successor-verification`, {
      token: scene.successor.sessionToken,
      body: {
        digest: DIGEST_MATCH,
        record_counts: COUNTS,
        destination_zone_name: DESTINATION.destination_zone_name,
        destination_zone_owner_name: DESTINATION.destination_zone_owner_name,
      },
    });
    expect(retry.status).toBe(200);
    expect(okBody(retry.body).data.transfer.phase).toBe('verified');

    const memberships = await sql.unsafe<{ user_id: string; role: string }[]>(
      `SELECT user_id, role FROM memberships WHERE household_id = $1 ORDER BY joined_at ASC`,
      [scene.householdId],
    );
    expect(memberships).toEqual([
      { user_id: scene.owner.userId, role: 'owner' },
      { user_id: scene.successor.userId, role: 'owner' },
      { user_id: scene.bystander.userId, role: 'member' },
    ]);
  });
});

// ── Source deleted ────────────────────────────────────────────────────────

describe('POST /api/account-deletion/transfers/:id/source-deleted', () => {
  it('records verified source-zone absence', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'verified');

    const res = await api('POST', `${BASE}/${id}/source-deleted`, {
      token: scene.owner.sessionToken,
    });
    expect(res.status).toBe(200);
    expect(okBody(res.body).data.transfer.phase).toBe('source_deleted');
  });

  it('refuses the successor', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'verified');

    const res = await api('POST', `${BASE}/${id}/source-deleted`, {
      token: scene.successor.sessionToken,
    });
    expect(res.status).toBe(403);
    expect(errBody(res.body).error.code).toBe('forbidden');
    expect(await phaseOf(id)).toBe('verified');
  });

  it('refuses source deletion before both parties verified', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'owner_verified');

    const res = await api('POST', `${BASE}/${id}/source-deleted`, {
      token: scene.owner.sessionToken,
    });
    expect(res.status).toBe(409);
    const err = errBody(res.body).error;
    expect(err.code).toBe('phase_conflict');
    expect(err.phase).toBe('owner_verified');
  });

  it('is idempotent on retry', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'source_deleted');

    const retry = await api('POST', `${BASE}/${id}/source-deleted`, {
      token: scene.owner.sessionToken,
    });
    expect(retry.status).toBe(200);
    expect(okBody(retry.body).data.transfer.phase).toBe('source_deleted');
  });
});

// ── Status / resume ───────────────────────────────────────────────────────

describe('GET /api/account-deletion/transfers/:id', () => {
  it('lets both bound parties resume the durable phase', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'destination_ready');

    const asOwner = await api('GET', `${BASE}/${id}`, { token: scene.owner.sessionToken });
    expect(asOwner.status).toBe(200);
    expect(okBody(asOwner.body).data.transfer.phase).toBe('destination_ready');
    // Status never leaks a usable token.
    expect(okBody(asOwner.body).data.handoff_token ?? null).toBeNull();

    const asSuccessor = await api('GET', `${BASE}/${id}`, {
      token: scene.successor.sessionToken,
    });
    expect(asSuccessor.status).toBe(200);
    expect(okBody(asSuccessor.body).data.transfer.destination_zone_name).toBe(
      DESTINATION.destination_zone_name,
    );
  });

  it('refuses an unbound household member and an unrelated account', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'successor_bound');

    for (const party of [scene.bystander, scene.outsider]) {
      const res = await api('GET', `${BASE}/${id}`, { token: party.sessionToken });
      expect(res.status).toBe(403);
      expect(errBody(res.body).error.code).toBe('forbidden');
    }
  });

  it('404s an unknown id', async () => {
    const scene = await seedScene();
    const res = await api('GET', `${BASE}/nope`, { token: scene.owner.sessionToken });
    expect(res.status).toBe(404);
  });
});

// ── Cancellation ──────────────────────────────────────────────────────────

describe('DELETE /api/account-deletion/transfers/:id', () => {
  it('cancels a pre-copy transfer and leaves the source garden untouched', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'destination_ready');

    const res = await api('DELETE', `${BASE}/${id}`, { token: scene.owner.sessionToken });
    expect(res.status).toBe(200);
    const { transfer } = okBody(res.body).data;
    expect(transfer.phase).toBe('cancelled');
    expect(transfer.cancelled_at).not.toBeNull();

    expect(await roleOf(scene.householdId, scene.owner.userId)).toBe('owner');
    expect(await roleOf(scene.householdId, scene.successor.userId)).toBe('member');
  });

  it('refuses the successor', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'successor_bound');

    const res = await api('DELETE', `${BASE}/${id}`, { token: scene.successor.sessionToken });
    expect(res.status).toBe(403);
    expect(errBody(res.body).error.code).toBe('forbidden');
    expect(await phaseOf(id)).toBe('successor_bound');
  });

  it('is idempotent', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'successor_bound');

    await api('DELETE', `${BASE}/${id}`, { token: scene.owner.sessionToken });
    const retry = await api('DELETE', `${BASE}/${id}`, { token: scene.owner.sessionToken });
    expect(retry.status).toBe(200);
    expect(okBody(retry.body).data.transfer.phase).toBe('cancelled');
  });

  it('refuses cancellation once the source zone is gone', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'source_deleted');

    const res = await api('DELETE', `${BASE}/${id}`, { token: scene.owner.sessionToken });
    expect(res.status).toBe(409);
    const err = errBody(res.body).error;
    expect(err.code).toBe('phase_conflict');
    expect(err.phase).toBe('source_deleted');
    expect(await phaseOf(id)).toBe('source_deleted');
  });

  it('frees the owner to start a fresh transfer after cancelling', async () => {
    const scene = await seedScene();
    const { id: first } = await driveTo(scene, 'successor_bound');
    await api('DELETE', `${BASE}/${first}`, { token: scene.owner.sessionToken });

    const res = await api('POST', BASE, { token: scene.owner.sessionToken });
    expect(res.status).toBe(200);
    const { transfer, handoff_token: token } = okBody(res.body).data;
    expect(transfer.id).not.toBe(first);
    expect(transfer.phase).toBe('pending_successor');
    expect(typeof token).toBe('string');
  });
});

// ── Guarded final account deletion ────────────────────────────────────────

describe('DELETE /api/me — CloudKit disposition gate', () => {
  it('refuses a request with no disposition and keeps credentials alive', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'verified');

    const res = await api('DELETE', '/api/me', { token: scene.owner.sessionToken });
    expect(res.status).toBe(400);
    expect(errBody(res.body).error.code).toBe('cloudkit_disposition_required');

    // Credentials survive: the session still authenticates.
    const probe = await api('GET', '/api/me', { token: scene.owner.sessionToken });
    expect(probe.status).toBe(200);

    const userRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM "user" WHERE id = $1`,
      [scene.owner.userId],
    );
    expect(userRows.length).toBe(1);
    expect(await roleOf(scene.householdId, scene.owner.userId)).toBe('owner');
    expect(await phaseOf(id)).toBe('verified');
  });

  it('refuses an unrecognized disposition', async () => {
    const scene = await seedScene();

    const res = await api('DELETE', '/api/me', {
      token: scene.owner.sessionToken,
      body: { cloudkit_disposition: 'trust_me' },
    });
    expect(res.status).toBe(400);
    expect(errBody(res.body).error.code).toBe('cloudkit_disposition_required');

    const userRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM "user" WHERE id = $1`,
      [scene.owner.userId],
    );
    expect(userRows.length).toBe(1);
  });

  it('refuses a transfer claim with no matching source-deleted transfer', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'verified');

    const res = await api('DELETE', '/api/me', {
      token: scene.owner.sessionToken,
      body: { cloudkit_disposition: 'transfer_source_deleted', transfer_id: id },
    });
    expect(res.status).toBe(409);
    expect(errBody(res.body).error.code).toBe('cloudkit_transfer_required');

    const probe = await api('GET', '/api/me', { token: scene.owner.sessionToken });
    expect(probe.status).toBe(200);
    expect(await phaseOf(id)).toBe('verified');
  });

  it('refuses a transfer claim that names another account’s transfer', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'source_deleted');

    const res = await api('DELETE', '/api/me', {
      token: scene.successor.sessionToken,
      body: { cloudkit_disposition: 'transfer_source_deleted', transfer_id: id },
    });
    expect(res.status).toBe(409);
    expect(errBody(res.body).error.code).toBe('cloudkit_transfer_required');

    const rows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM "user" WHERE id = $1`,
      [scene.successor.userId],
    );
    expect(rows.length).toBe(1);
  });

  it('refuses a simpler disposition while the caller owns an in-flight transfer', async () => {
    const scene = await seedScene();
    await driveTo(scene, 'owner_verified');

    for (const disposition of [
      'participant_left_share',
      'owner_zone_deleted',
      'no_cloudkit_garden',
    ]) {
      const res = await api('DELETE', '/api/me', {
        token: scene.owner.sessionToken,
        body: { cloudkit_disposition: disposition },
      });
      expect(res.status).toBe(409);
      expect(errBody(res.body).error.code).toBe('cloudkit_transfer_required');
    }

    const userRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM "user" WHERE id = $1`,
      [scene.owner.userId],
    );
    expect(userRows.length).toBe(1);
  });

  it('completes deletion from source_deleted, leaving the successor in charge', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'source_deleted');

    const res = await api('DELETE', '/api/me', {
      token: scene.owner.sessionToken,
      body: { cloudkit_disposition: 'transfer_source_deleted', transfer_id: id },
    });
    expect(res.status).toBe(200);

    const userRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM "user" WHERE id = $1`,
      [scene.owner.userId],
    );
    expect(userRows.length).toBe(0);

    // Household survives, now owned by the successor.
    const hhRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM households WHERE id = $1`,
      [scene.householdId],
    );
    expect(hhRows.length).toBe(1);
    expect(await roleOf(scene.householdId, scene.owner.userId)).toBeNull();
    expect(await roleOf(scene.householdId, scene.successor.userId)).toBe('owner');

    // The transfer row goes with the deleted owner.
    expect(await phaseOf(id)).toBeNull();
  });

  it('lets an owner cancel a stale transfer and then delete a solo garden', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'successor_bound');

    // Everyone else leaves; the handoff is dead but still on file.
    await sql.unsafe(
      `DELETE FROM memberships WHERE household_id = $1 AND user_id IN ($2, $3)`,
      [scene.householdId, scene.successor.userId, scene.bystander.userId],
    );

    const blocked = await api('DELETE', '/api/me', {
      token: scene.owner.sessionToken,
      body: { cloudkit_disposition: 'owner_zone_deleted' },
    });
    expect(blocked.status).toBe(409);
    expect(errBody(blocked.body).error.code).toBe('cloudkit_transfer_required');

    const cancelled = await api('DELETE', `${BASE}/${id}`, { token: scene.owner.sessionToken });
    expect(cancelled.status).toBe(200);

    const deleted = await api('DELETE', '/api/me', {
      token: scene.owner.sessionToken,
      body: { cloudkit_disposition: 'owner_zone_deleted' },
    });
    expect(deleted.status).toBe(200);

    const hhRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM households WHERE id = $1`,
      [scene.householdId],
    );
    expect(hhRows.length).toBe(0);
  });

  it('lets a participant delete with their own disposition mid-transfer', async () => {
    const scene = await seedScene();
    await driveTo(scene, 'successor_bound');

    // The bystander owns no transfer, so the owner's in-flight handoff
    // does not block them.
    const res = await api('DELETE', '/api/me', {
      token: scene.bystander.sessionToken,
      body: { cloudkit_disposition: 'participant_left_share' },
    });
    expect(res.status).toBe(200);

    const rows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM "user" WHERE id = $1`,
      [scene.bystander.userId],
    );
    expect(rows.length).toBe(0);
    expect(await roleOf(scene.householdId, scene.owner.userId)).toBe('owner');
  });
});

// ── Concurrency ───────────────────────────────────────────────────────────

describe('concurrent transfer operations', () => {
  it('hands out one usable token when two devices resume a stale handoff at once', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'pending_successor');
    await sql.unsafe(
      `UPDATE account_deletion_transfers SET handoff_expires_at = $1 WHERE id = $2`,
      [Date.now() - 1000, id],
    );

    const [a, b] = await Promise.all([
      api('POST', BASE, { token: scene.owner.sessionToken }),
      api('POST', BASE, { token: scene.owner.sessionToken }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    // Exactly one caller may mint; the loser reports the durable row.
    const issued = [okBody(a.body).data.handoff_token, okBody(b.body).data.handoff_token].filter(
      (t): t is string => typeof t === 'string',
    );
    expect(issued.length).toBe(1);

    const row = (await transferRow(id))!;
    expect(row.handoff_token_hash).toBe(
      createHash('sha256').update(issued[0], 'utf8').digest('hex'),
    );

    const accepted = await api('POST', `${BASE}/${id}/accept`, {
      token: scene.successor.sessionToken,
      body: { token: issued[0] },
    });
    expect(accepted.status).toBe(200);
  });

  it('serializes a successor account deletion against the owner’s source-deleted step', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'verified');

    const [successorDelete, sourceDeleted] = await Promise.all([
      api('DELETE', '/api/me', {
        token: scene.successor.sessionToken,
        body: { cloudkit_disposition: 'owner_zone_deleted' },
      }),
      api('POST', `${BASE}/${id}/source-deleted`, { token: scene.owner.sessionToken }),
    ]);

    // The owner always gets through: either the successor's deletion was
    // refused (transfer still verified) or it ran after the source was
    // already recorded gone. The successor can never vanish mid-handoff.
    expect(sourceDeleted.status).toBe(200);
    expect(await phaseOf(id)).toBe('source_deleted');
    expect([200, 409]).toContain(successorDelete.status);

    const successorRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM "user" WHERE id = $1`,
      [scene.successor.userId],
    );
    expect(successorRows.length).toBe(successorDelete.status === 200 ? 0 : 1);
  });
});

// ── Successor liveness ────────────────────────────────────────────────────

describe('successor liveness', () => {
  it('refuses source-deleted when the bound successor is gone', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'verified');
    await sql.unsafe(
      `UPDATE account_deletion_transfers SET successor_user_id = NULL WHERE id = $1`,
      [id],
    );

    const res = await api('POST', `${BASE}/${id}/source-deleted`, {
      token: scene.owner.sessionToken,
    });
    expect(res.status).toBe(409);
    expect(errBody(res.body).error.code).toBe('successor_unavailable');
    expect(await phaseOf(id)).toBe('verified');
  });

  it('refuses source-deleted when the successor no longer owns the household', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'verified');
    await sql.unsafe(
      `DELETE FROM memberships WHERE household_id = $1 AND user_id = $2`,
      [scene.householdId, scene.successor.userId],
    );

    const res = await api('POST', `${BASE}/${id}/source-deleted`, {
      token: scene.owner.sessionToken,
    });
    expect(res.status).toBe(409);
    expect(errBody(res.body).error.code).toBe('successor_unavailable');
    expect(await phaseOf(id)).toBe('verified');
  });

  it('refuses the bound successor’s own account deletion while the handoff is unfinished', async () => {
    const scene = await seedScene();

    for (const phase of ['successor_bound', 'verified'] as const) {
      const fresh = await seedScene();
      await driveTo(fresh, phase);

      const res = await api('DELETE', '/api/me', {
        token: fresh.successor.sessionToken,
        body: { cloudkit_disposition: 'owner_zone_deleted' },
      });
      expect(res.status).toBe(409);
      expect(errBody(res.body).error.code).toBe('cloudkit_transfer_required');

      // Credentials and membership survive.
      const probe = await api('GET', '/api/me', { token: fresh.successor.sessionToken });
      expect(probe.status).toBe(200);
      const rows = await sql.unsafe<{ id: string }[]>(
        `SELECT id FROM "user" WHERE id = $1`,
        [fresh.successor.userId],
      );
      expect(rows.length).toBe(1);
    }

    expect(scene.householdId).toBeTruthy();
  });

  it('lets the successor delete once the owner cancels the handoff', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'verified');

    const blocked = await api('DELETE', '/api/me', {
      token: scene.successor.sessionToken,
      body: { cloudkit_disposition: 'participant_left_share' },
    });
    expect(blocked.status).toBe(409);

    const cancelled = await api('DELETE', `${BASE}/${id}`, { token: scene.owner.sessionToken });
    expect(cancelled.status).toBe(200);

    const deleted = await api('DELETE', '/api/me', {
      token: scene.successor.sessionToken,
      body: { cloudkit_disposition: 'participant_left_share' },
    });
    expect(deleted.status).toBe(200);

    const rows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM "user" WHERE id = $1`,
      [scene.successor.userId],
    );
    expect(rows.length).toBe(0);
  });

  it('lets the successor delete once the source zone is recorded gone', async () => {
    const scene = await seedScene();
    await driveTo(scene, 'source_deleted');

    const res = await api('DELETE', '/api/me', {
      token: scene.successor.sessionToken,
      body: { cloudkit_disposition: 'owner_zone_deleted' },
    });
    expect(res.status).toBe(200);
  });
});

// ── Cancellation after membership re-home ─────────────────────────────────

describe('cancelling a verified transfer', () => {
  it('demotes a successor who was already a member', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'verified');
    expect(await roleOf(scene.householdId, scene.successor.userId)).toBe('owner');

    const res = await api('DELETE', `${BASE}/${id}`, { token: scene.owner.sessionToken });
    expect(res.status).toBe(200);
    expect(okBody(res.body).data.transfer.phase).toBe('cancelled');

    // Back exactly where they started; the owner keeps the garden.
    expect(await roleOf(scene.householdId, scene.successor.userId)).toBe('member');
    expect(await roleOf(scene.householdId, scene.owner.userId)).toBe('owner');
  });

  it('removes a membership the transfer created', async () => {
    const scene = await seedScene();
    const { id } = await driveTo(scene, 'verified', scene.outsider);
    expect(await roleOf(scene.householdId, scene.outsider.userId)).toBe('owner');

    const res = await api('DELETE', `${BASE}/${id}`, { token: scene.owner.sessionToken });
    expect(res.status).toBe(200);
    expect(await roleOf(scene.householdId, scene.outsider.userId)).toBeNull();

    // And the abandoned successor has no authority left over the garden.
    const attempt = await api('POST', BASE, { token: scene.outsider.sessionToken });
    expect(attempt.status).toBe(403);
  });

  it('leaves a successor who was already an owner untouched', async () => {
    const scene = await seedScene();
    await sql.unsafe(
      `UPDATE memberships SET role = 'owner' WHERE household_id = $1 AND user_id = $2`,
      [scene.householdId, scene.successor.userId],
    );
    const { id } = await driveTo(scene, 'verified');

    const res = await api('DELETE', `${BASE}/${id}`, { token: scene.owner.sessionToken });
    expect(res.status).toBe(200);
    expect(await roleOf(scene.householdId, scene.successor.userId)).toBe('owner');
  });
});
