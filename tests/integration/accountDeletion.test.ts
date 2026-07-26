/**
 * M5 · integration tests for DELETE /api/me (account deletion).
 *
 * Every request carries an explicit `cloudkit_disposition`: the server
 * cannot observe CloudKit, so the device states what it did with the
 * iCloud garden before asking for erasure, and a request without one is
 * refused (see `auth.ts` and accountDeletionTransfer.test.ts).
 *
 * Covers all four data-disposal cases from spec A4:
 *   (a) Sole-member — user, household, seeds, journal, assistant all gone;
 *       catalog_feedback.user_id SET NULL; deletePhoto called for all 3 key
 *       sources (seed photo, journal photo, extraction with a 2-key array).
 *   (b) Multi-member, caller is a non-owner member — caller's membership +
 *       user gone, household + other owner + their seed intact.
 *   (c) Multi-member, caller is the only owner — fails closed without a
 *       disposition, and otherwise promotes the oldest other member.
 *   (d) User with NO household — deletes cleanly, no 409.
 *   (e) Caller with MORE THAN ONE membership — every household the caller
 *       belongs to is disposed of by its own rule in one transaction, so a
 *       re-homed transfer successor cannot leave their original household
 *       behind with no members.
 *   (f) Two last members deleting concurrently — the household never
 *       survives with zero members.
 *
 * Plus the durable receipt capability: written inside the deletion
 * transaction, expired receipts are indistinguishable from unknown ones,
 * and repeated misses from one client are rate limited.
 *
 * Run with:
 *   bun test tests/integration/accountDeletion.test.ts
 *
 * Prerequisites:
 *   - Local Postgres reachable at DATABASE_URL
 *   - Migrations 0001–0029 applied (`bun run migrate`)
 */

import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import postgres, { type Sql } from 'postgres';
import type { Hono } from 'hono';
import { createApp } from '../../src/index';
import { createHash } from 'node:crypto';
import type { AppEnv } from '../../src/index';
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

// Capture keys passed to deletePhoto so we can assert them in tests.
const deletedKeys: string[] = [];

// Mock storage module to intercept deletePhoto calls.
mock.module('../../src/lib/storage', () => ({
  deletePhoto: async (_env: unknown, key: string) => {
    deletedKeys.push(key);
  },
  putPhoto: async () => {},
  getPhoto: async () => null,
  newPhotoKey: () => 'mocked-key',
  isAllowedMime: () => true,
}));

const TEST_MASTER_KEY = Buffer.from('test-master-key-for-account-deletion-01').toString('base64');

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

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 12)}`;
}

function receiptHash(raw: string = uid('receipt')): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

interface Fixture {
  userId: string;
  householdId: string;
  sessionToken: string;
}

async function seedUser(): Promise<{ userId: string; sessionToken: string }> {
  const userId = uid('ad-user');
  const sessionId = uid('ad-sess');
  const sessionToken = uid('ad-tok');
  const now = Date.now();

  await sql.unsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'Del User', $2, TRUE,
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
  const householdId = uid('ad-hh');
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO households (id, name, created_at, updated_at)
     VALUES ($1, 'Del Household', $2, $2)`,
    [householdId, now],
  );
  return householdId;
}

async function addMembership(
  householdId: string,
  userId: string,
  role: 'owner' | 'member',
  joinedAtOffset: number = 0,
): Promise<void> {
  const now = Date.now() + joinedAtOffset;
  await sql.unsafe(
    `INSERT INTO memberships (household_id, user_id, role, joined_at)
     VALUES ($1, $2, $3, $4)`,
    [householdId, userId, role, now],
  );
}

async function seedFixture(role: 'owner' | 'member' = 'owner'): Promise<Fixture> {
  const { userId, sessionToken } = await seedUser();
  const householdId = await seedHousehold();
  await addMembership(householdId, userId, role);
  return { userId, householdId, sessionToken };
}

/**
 * DELETE /api/me with an explicit CloudKit disposition and a unique
 * deletion receipt by default. Pass `addReceipt = false` to exercise the
 * fail-closed receipt validation path.
 */
async function deleteMe(
  app: Hono<AppEnv>,
  sessionToken: string,
  body: Record<string, unknown> | null,
  addReceipt = true,
): Promise<Response> {
  const requestBody =
    body === null
      ? null
      : addReceipt
        ? { deletion_receipt_hash: receiptHash(), ...body }
        : body;
  return app.request(
    '/api/me',
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        ...(requestBody === null ? {} : { 'Content-Type': 'application/json' }),
      },
      body: requestBody === null ? undefined : JSON.stringify(requestBody),
    },
    TEST_ENV,
  );
}

async function seedCatalogSeed(): Promise<string> {
  const id = uid('ad-cat');
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO catalog_seeds
       (id, common_name, days_to_maturity_min, days_to_maturity_max,
        sun_requirement, status, created_at, updated_at, published_at)
     VALUES ($1, 'TestPlant', 50, 70, 'full', 'published', $2::BIGINT, $2::BIGINT, $2::BIGINT)`,
    [id, now],
  );
  return id;
}

async function seedSeed(householdId: string): Promise<string> {
  const id = uid('ad-seed');
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO seeds
       (id, household_id, state, created_at, updated_at)
     VALUES ($1, $2, 'active', $3, $3)`,
    [id, householdId, now],
  );
  return id;
}

async function seedJournalEntry(householdId: string): Promise<string> {
  const id = uid('ad-je');
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO journal_entries
       (id, household_id, occurred_on, body, created_at, updated_at)
     VALUES ($1, $2, CURRENT_DATE, 'test entry', $3, $3)`,
    [id, householdId, now],
  );
  return id;
}

async function seedAssistantThread(householdId: string): Promise<string> {
  const id = uid('ad-at');
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO assistant_threads
       (id, household_id, title, created_at, updated_at)
     VALUES ($1, $2, 'Test Thread', $3, $3)`,
    [id, householdId, now],
  );
  return id;
}

beforeAll(async () => {
  await sql`SELECT 1`;
  deletedKeys.length = 0;
});

afterAll(async () => {
  await sql
    .unsafe(`DELETE FROM account_deletion_receipts WHERE deleted_user_id LIKE 'ad-user-%'`)
    .catch(() => {});
  await sql.end({ timeout: 5 });
});

/**
 * A seed plus a seed photo, returning the storage key the deletion route
 * is expected to hand to deletePhoto.
 */
async function seedSeedWithPhoto(householdId: string): Promise<string> {
  const seedId = await seedSeed(householdId);
  const key = `households/${householdId}/seeds/${seedId}/front-test.jpg`;
  await sql.unsafe(
    `INSERT INTO seed_photos
       (id, seed_id, household_id, r2_key, role, captured_at)
     VALUES ($1, $2, $3, $4, 'front', $5)`,
    [uid('ad-sp'), seedId, householdId, key, Date.now()],
  );
  return key;
}

async function membershipsOf(userId: string): Promise<string[]> {
  const rows = await sql.unsafe<{ household_id: string }[]>(
    `SELECT household_id FROM memberships WHERE user_id = $1`,
    [userId],
  );
  return rows.map((r) => r.household_id);
}

async function householdExists(householdId: string): Promise<boolean> {
  const rows = await sql.unsafe<{ id: string }[]>(`SELECT id FROM households WHERE id = $1`, [
    householdId,
  ]);
  return rows.length === 1;
}

async function lookupReceipt(
  app: Hono<AppEnv>,
  receiptToken: string,
  clientIp?: string,
): Promise<Response> {
  return app.request(
    '/api/account-deletion/receipts/lookup',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(clientIp === undefined ? {} : { 'Fly-Client-IP': clientIp }),
      },
      body: JSON.stringify({ receipt_token: receiptToken }),
    },
    TEST_ENV,
  );
}

// ── (a) Sole-member full deletion ─────────────────────────────────────────────

describe('DELETE /api/me — sole-member household', () => {
  it('deletes user, household, seeds, journal; sets catalog_feedback.user_id to NULL; calls deletePhoto for all 3 key sources', async () => {
    deletedKeys.length = 0;

    const fx = await seedFixture('owner');
    const app = createApp(TEST_ENV);

    // Seed a seed row.
    const seedId = await seedSeed(fx.householdId);

    // Seed a seed photo with a known key.
    const seedPhotoKey = `households/${fx.householdId}/seeds/${seedId}/front-test.jpg`;
    const seedPhotoId = uid('ad-sp');
    await sql.unsafe(
      `INSERT INTO seed_photos
         (id, seed_id, household_id, r2_key, role, captured_at)
       VALUES ($1, $2, $3, $4, 'front', $5)`,
      [seedPhotoId, seedId, fx.householdId, seedPhotoKey, Date.now()],
    );

    // Seed an assistant thread.
    const threadId = await seedAssistantThread(fx.householdId);

    // Seed a journal entry.
    const jeId = await seedJournalEntry(fx.householdId);

    // Seed a journal photo with a known key.
    const journalPhotoKey = `households/${fx.householdId}/journal/${jeId}/photo-test.jpg`;
    const journalPhotoId = uid('ad-jp');
    await sql.unsafe(
      `INSERT INTO journal_entry_photos
         (id, entry_id, household_id, storage_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [journalPhotoId, jeId, fx.householdId, journalPhotoKey, Date.now()],
    );

    // Seed a catalog extraction with a 2-key source_photo_keys array.
    const extractionKey1 = `households/${fx.householdId}/extractions/ext-test1.jpg`;
    const extractionKey2 = `households/${fx.householdId}/extractions/ext-test2.jpg`;
    const extractionId = uid('ad-ext');
    await sql.unsafe(
      `INSERT INTO catalog_extractions
         (id, submitted_by_household, submitted_by_user, source_photo_keys,
          vision_model_id, raw_extraction, status, created_at)
       VALUES ($1, $2, $3, $4, 'claude-sonnet-4-6', '{}', 'pending', $5)`,
      [
        extractionId,
        fx.householdId,
        fx.userId,
        JSON.stringify([extractionKey1, extractionKey2]),
        Date.now(),
      ],
    );

    // Seed a catalog_feedback row referencing this user (to test SET NULL).
    const catalogSeedId = await seedCatalogSeed();
    const feedbackId = uid('cf');
    await sql.unsafe(
      `INSERT INTO catalog_feedback
         (id, catalog_seed_id, household_id, user_id, body, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'test feedback', 'open', $5::BIGINT, $5::BIGINT)`,
      [feedbackId, catalogSeedId, fx.householdId, fx.userId, Date.now()],
    );

    // Call the route.
    const res = await deleteMe(app, fx.sessionToken, {
      cloudkit_disposition: 'owner_zone_deleted',
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { deleted: boolean } };
    expect(json.ok).toBe(true);
    expect(json.data.deleted).toBe(true);

    // User row is gone.
    const userRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM "user" WHERE id = $1`,
      [fx.userId],
    );
    expect(userRows.length).toBe(0);

    // Household is gone.
    const hhRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM households WHERE id = $1`,
      [fx.householdId],
    );
    expect(hhRows.length).toBe(0);

    // Seed is gone (cascaded from household).
    const seedRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM seeds WHERE id = $1`,
      [seedId],
    );
    expect(seedRows.length).toBe(0);

    // Journal entry is gone.
    const jeRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM journal_entries WHERE id = $1`,
      [jeId],
    );
    expect(jeRows.length).toBe(0);

    // Assistant thread is gone (cascaded from household).
    const threadRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM assistant_threads WHERE id = $1`,
      [threadId],
    );
    expect(threadRows.length).toBe(0);

    // catalog_feedback row survives but user_id is NULL (SET NULL).
    const feedbackRows = await sql.unsafe<{ id: string; user_id: string | null }[]>(
      `SELECT id, user_id FROM catalog_feedback WHERE id = $1`,
      [feedbackId],
    );
    // catalog_feedback.user_id + household_id are both ON DELETE SET NULL
    // (migration 0020), so the row MUST survive with user_id NULL. Asserted
    // unconditionally so a regression re-introducing CASCADE is caught.
    expect(feedbackRows.length).toBe(1);
    expect(feedbackRows[0]!.user_id).toBeNull();

    // deletePhoto was called for all 3 key sources.
    expect(deletedKeys).toContain(seedPhotoKey);
    expect(deletedKeys).toContain(journalPhotoKey);
    expect(deletedKeys).toContain(extractionKey1);
    expect(deletedKeys).toContain(extractionKey2);

    // Clean up catalog_seed (feedback may already be gone via cascade).
    await sql.unsafe(`DELETE FROM catalog_feedback WHERE id = $1`, [feedbackId]).catch(() => {});
    await sql.unsafe(`DELETE FROM catalog_audit_log WHERE catalog_seed_id = $1`, [catalogSeedId]).catch(() => {});
    await sql.unsafe(`DELETE FROM catalog_seeds WHERE id = $1`, [catalogSeedId]).catch(() => {});
  });
});

// ── (a-ii) Gap-closer: catalog_feedback SURVIVES with user_id = NULL ─────────

describe('DELETE /api/me — sole-member: catalog_feedback survival', () => {
  it('catalog_feedback row survives with user_id=NULL after sole-member deletion (positive survival case)', async () => {
    deletedKeys.length = 0;

    const fx = await seedFixture('owner');
    const app = createApp(TEST_ENV);

    const catalogSeedId = await seedCatalogSeed();
    const feedbackId = uid('cf-surv');
    await sql.unsafe(
      `INSERT INTO catalog_feedback
         (id, catalog_seed_id, household_id, user_id, body, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'test feedback survival', 'open', $5::BIGINT, $5::BIGINT)`,
      [feedbackId, catalogSeedId, fx.householdId, fx.userId, Date.now()],
    );

    const res = await deleteMe(app, fx.sessionToken, {
      cloudkit_disposition: 'owner_zone_deleted',
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { deleted: boolean } };
    expect(json.ok).toBe(true);
    expect(json.data.deleted).toBe(true);

    // POSITIVE SURVIVAL ASSERTION: the row MUST survive with user_id=NULL.
    // (catalog_feedback.user_id FK is ON DELETE SET NULL;
    //  catalog_feedback.household_id FK is also ON DELETE SET NULL.)
    // Guards against a silent cascade-delete regression.
    const feedbackRows = await sql.unsafe<{ id: string; user_id: string | null; household_id: string | null }[]>(
      `SELECT id, user_id, household_id FROM catalog_feedback WHERE id = $1`,
      [feedbackId],
    );
    expect(feedbackRows.length).toBe(1);
    expect(feedbackRows[0]!.user_id).toBeNull();
    // household_id is also SET NULL when household is deleted.
    expect(feedbackRows[0]!.household_id).toBeNull();

    // Clean up.
    await sql.unsafe(`DELETE FROM catalog_feedback WHERE id = $1`, [feedbackId]).catch(() => {});
    await sql.unsafe(`DELETE FROM catalog_audit_log WHERE catalog_seed_id = $1`, [catalogSeedId]).catch(() => {});
    await sql.unsafe(`DELETE FROM catalog_seeds WHERE id = $1`, [catalogSeedId]).catch(() => {});
  });
});

// ── (a-iii) Gap-closer: source_photo_keys edge cases on catalog_extractions ──

describe('DELETE /api/me — sole-member: source_photo_keys edge cases', () => {
  it('empty array [] contributes 0 keys; deletion still returns 200', async () => {
    deletedKeys.length = 0;

    const fx = await seedFixture('owner');
    const app = createApp(TEST_ENV);

    const extractionId = uid('ad-ext-empty');
    await sql.unsafe(
      `INSERT INTO catalog_extractions
         (id, submitted_by_household, submitted_by_user, source_photo_keys,
          vision_model_id, raw_extraction, status, created_at)
       VALUES ($1, $2, $3, $4, 'claude-sonnet-4-6', '{}', 'pending', $5)`,
      [extractionId, fx.householdId, fx.userId, JSON.stringify([]), Date.now()],
    );

    const res = await deleteMe(app, fx.sessionToken, {
      cloudkit_disposition: 'owner_zone_deleted',
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { deleted: boolean } };
    expect(json.ok).toBe(true);
    // Empty array contributes 0 keys — no deletePhoto calls beyond any other sources.
    // (No seed_photos or journal_entry_photos were seeded here.)
    expect(deletedKeys.length).toBe(0);
  });

  it('malformed JSON in source_photo_keys is silently skipped; deletion still 200', async () => {
    deletedKeys.length = 0;

    const fx = await seedFixture('owner');
    const app = createApp(TEST_ENV);

    const extractionId = uid('ad-ext-bad');
    await sql.unsafe(
      `INSERT INTO catalog_extractions
         (id, submitted_by_household, submitted_by_user, source_photo_keys,
          vision_model_id, raw_extraction, status, created_at)
       VALUES ($1, $2, $3, $4, 'claude-sonnet-4-6', '{}', 'pending', $5)`,
      [extractionId, fx.householdId, fx.userId, 'not-json', Date.now()],
    );

    const res = await deleteMe(app, fx.sessionToken, {
      cloudkit_disposition: 'owner_zone_deleted',
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { deleted: boolean } };
    expect(json.ok).toBe(true);
    // Malformed JSON silently skipped — no crash, no keys.
    expect(deletedKeys.length).toBe(0);
  });

  it('non-string element in source_photo_keys array does not crash; valid string keys still collected', async () => {
    deletedKeys.length = 0;

    const fx = await seedFixture('owner');
    const app = createApp(TEST_ENV);

    const validKey = `households/${fx.householdId}/extractions/valid-key.jpg`;
    const extractionId = uid('ad-ext-mixed');
    // Array with one non-string element (number) and one string key.
    await sql.unsafe(
      `INSERT INTO catalog_extractions
         (id, submitted_by_household, submitted_by_user, source_photo_keys,
          vision_model_id, raw_extraction, status, created_at)
       VALUES ($1, $2, $3, $4, 'claude-sonnet-4-6', '{}', 'pending', $5)`,
      [extractionId, fx.householdId, fx.userId, JSON.stringify([123, validKey]), Date.now()],
    );

    const res = await deleteMe(app, fx.sessionToken, {
      cloudkit_disposition: 'owner_zone_deleted',
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { deleted: boolean } };
    expect(json.ok).toBe(true);
    // The numeric element is included as-is since array.isArray filter doesn't
    // strip non-strings — the route does (parsed as string[]). Whether the
    // string '123' or validKey ends up in deletedKeys depends on the cast
    // behavior. The key guarantee is: no crash, deletion returns 200.
    // The valid string key SHOULD be in deletedKeys.
    expect(deletedKeys).toContain(validKey);
  });
});

// ── (b) Multi-member, caller is a non-owner member ───────────────────────────

describe('DELETE /api/me — multi-member, caller is non-owner', () => {
  it("deletes caller's membership + user; household, other owner, and their seed remain intact", async () => {
    deletedKeys.length = 0;

    // Owner stays.
    const { userId: ownerUserId, sessionToken: _ownerToken } = await seedUser();
    // Non-owner caller.
    const { userId: callerUserId, sessionToken: callerToken } = await seedUser();

    const householdId = await seedHousehold();
    await addMembership(householdId, ownerUserId, 'owner', 0);
    await addMembership(householdId, callerUserId, 'member', 1000);

    // Seed a row belonging to the owner.
    const sharedSeedId = await seedSeed(householdId);

    const app = createApp(TEST_ENV);

    const res = await deleteMe(app, callerToken, {
      cloudkit_disposition: 'participant_left_share',
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { deleted: boolean } };
    expect(json.ok).toBe(true);
    expect(json.data.deleted).toBe(true);

    // Caller user is gone.
    const callerRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM "user" WHERE id = $1`,
      [callerUserId],
    );
    expect(callerRows.length).toBe(0);

    // Caller membership is gone.
    const callerMembRows = await sql.unsafe<{ user_id: string }[]>(
      `SELECT user_id FROM memberships WHERE household_id = $1 AND user_id = $2`,
      [householdId, callerUserId],
    );
    expect(callerMembRows.length).toBe(0);

    // Household is intact.
    const hhRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM households WHERE id = $1`,
      [householdId],
    );
    expect(hhRows.length).toBe(1);

    // Other owner is still a member.
    const ownerMembRows = await sql.unsafe<{ user_id: string }[]>(
      `SELECT user_id FROM memberships WHERE household_id = $1 AND user_id = $2`,
      [householdId, ownerUserId],
    );
    expect(ownerMembRows.length).toBe(1);

    // Shared seed is intact.
    const seedRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM seeds WHERE id = $1`,
      [sharedSeedId],
    );
    expect(seedRows.length).toBe(1);

    // No S3 deletions occurred (household survives).
    expect(deletedKeys.length).toBe(0);

    // Clean up.
    await sql.unsafe(`DELETE FROM seeds WHERE id = $1`, [sharedSeedId]).catch(() => {});
    await sql.unsafe(`DELETE FROM memberships WHERE household_id = $1`, [householdId]).catch(() => {});
    await sql.unsafe(`DELETE FROM households WHERE id = $1`, [householdId]).catch(() => {});
    await sql.unsafe(`DELETE FROM "user" WHERE id = $1`, [ownerUserId]).catch(() => {});
  });
});

// ── (c) Multi-member, caller is the only owner ────────────────────────────────

describe('DELETE /api/me — multi-member, caller is the only owner', () => {
  it('refuses to delete anything when no CloudKit disposition is supplied', async () => {
    deletedKeys.length = 0;
    const { userId: ownerUserId, sessionToken: ownerToken } = await seedUser();
    const { userId: memberUserId } = await seedUser();
    const householdId = await seedHousehold();
    await addMembership(householdId, ownerUserId, 'owner', 0);
    await addMembership(householdId, memberUserId, 'member', 5000);

    const app = createApp(TEST_ENV);
    const res = await deleteMe(app, ownerToken, {});

    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe('cloudkit_disposition_required');

    const ownerRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM "user" WHERE id = $1`,
      [ownerUserId],
    );
    expect(ownerRows.length).toBe(1);
    const memberships = await sql.unsafe<{ role: string }[]>(
      `SELECT role FROM memberships WHERE household_id = $1 AND user_id = $2`,
      [householdId, ownerUserId],
    );
    expect(memberships).toEqual([{ role: 'owner' }]);
    expect(deletedKeys).toEqual([]);

    await sql.unsafe(`DELETE FROM memberships WHERE household_id = $1`, [householdId]).catch(() => {});
    await sql.unsafe(`DELETE FROM households WHERE id = $1`, [householdId]).catch(() => {});
    await sql.unsafe(`DELETE FROM "user" WHERE id IN ($1, $2)`, [ownerUserId, memberUserId]).catch(() => {});
  });

  it('refuses a shared-transfer claim with no matching transfer', async () => {
    deletedKeys.length = 0;
    const { userId: ownerUserId, sessionToken: ownerToken } = await seedUser();
    const { userId: memberUserId } = await seedUser();
    const householdId = await seedHousehold();
    await addMembership(householdId, ownerUserId, 'owner', 0);
    await addMembership(householdId, memberUserId, 'member', 5000);

    const app = createApp(TEST_ENV);
    const res = await deleteMe(app, ownerToken, {
      cloudkit_disposition: 'transfer_source_deleted',
      transfer_id: 'no-such-transfer',
    });

    expect(res.status).toBe(409);
    const json = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe('cloudkit_transfer_required');

    const ownerRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM "user" WHERE id = $1`,
      [ownerUserId],
    );
    expect(ownerRows.length).toBe(1);
    expect(deletedKeys).toEqual([]);

    await sql.unsafe(`DELETE FROM memberships WHERE household_id = $1`, [householdId]).catch(() => {});
    await sql.unsafe(`DELETE FROM households WHERE id = $1`, [householdId]).catch(() => {});
    await sql.unsafe(`DELETE FROM "user" WHERE id IN ($1, $2)`, [ownerUserId, memberUserId]).catch(() => {});
  });

  it('promotes the oldest remaining member once the garden step is reported done', async () => {
    deletedKeys.length = 0;
    const { userId: ownerUserId, sessionToken: ownerToken } = await seedUser();
    const { userId: memberUserId } = await seedUser();
    const householdId = await seedHousehold();
    await addMembership(householdId, ownerUserId, 'owner', 0);
    await addMembership(householdId, memberUserId, 'member', 5000);

    const app = createApp(TEST_ENV);
    const res = await deleteMe(app, ownerToken, {
      cloudkit_disposition: 'owner_zone_deleted',
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { deleted: boolean } };
    expect(json.data.deleted).toBe(true);

    const ownerRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM "user" WHERE id = $1`,
      [ownerUserId],
    );
    expect(ownerRows.length).toBe(0);

    // Household survives with the promoted member as its owner.
    const memberships = await sql.unsafe<{ user_id: string; role: string }[]>(
      `SELECT user_id, role FROM memberships WHERE household_id = $1`,
      [householdId],
    );
    expect(memberships).toEqual([{ user_id: memberUserId, role: 'owner' }]);
    expect(deletedKeys).toEqual([]);

    await sql.unsafe(`DELETE FROM memberships WHERE household_id = $1`, [householdId]).catch(() => {});
    await sql.unsafe(`DELETE FROM households WHERE id = $1`, [householdId]).catch(() => {});
    await sql.unsafe(`DELETE FROM "user" WHERE id = $1`, [memberUserId]).catch(() => {});
  });
});

// ── (d) User with NO household ────────────────────────────────────────────────

describe('DELETE /api/me — user with no household', () => {
  it('deletes user cleanly with no 409', async () => {
    deletedKeys.length = 0;

    const { userId, sessionToken } = await seedUser();
    const app = createApp(TEST_ENV);

    const res = await deleteMe(app, sessionToken, {
      cloudkit_disposition: 'no_cloudkit_garden',
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { deleted: boolean } };
    expect(json.ok).toBe(true);
    expect(json.data.deleted).toBe(true);

    // User row is gone.
    const userRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM "user" WHERE id = $1`,
      [userId],
    );
    expect(userRows.length).toBe(0);

    // No S3 deletions.
    expect(deletedKeys.length).toBe(0);
  });
});

// ── Durable account-deletion receipts ─────────────────────────────────────

describe('account-deletion receipts', () => {
  it('writes the receipt in the deletion transaction and looks it up without authentication', async () => {
    const { userId, sessionToken } = await seedUser();
    const app = createApp(TEST_ENV);
    const rawReceipt = uid('raw-receipt');
    const hash = receiptHash(rawReceipt);
    const before = Date.now();

    const deleted = await deleteMe(
      app,
      sessionToken,
      {
        cloudkit_disposition: 'no_cloudkit_garden',
        deletion_receipt_hash: hash,
      },
      false,
    );
    expect(deleted.status).toBe(200);

    const rows = await sql.unsafe<
      { receipt_hash: string; deleted_user_id: string; deleted_at: number; expires_at: number }[]
    >(
      `SELECT receipt_hash, deleted_user_id, deleted_at, expires_at
         FROM account_deletion_receipts
        WHERE receipt_hash = $1`,
      [hash],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deleted_user_id).toBe(userId);
    expect(rows[0]!.deleted_at).toBeGreaterThanOrEqual(before);
    expect(rows[0]!.expires_at - rows[0]!.deleted_at).toBe(30 * 24 * 60 * 60 * 1000);

    const userRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM "user" WHERE id = $1`,
      [userId],
    );
    expect(userRows).toHaveLength(0);

    const lookup = await app.request(
      '/api/account-deletion/receipts/lookup',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receipt_token: rawReceipt }),
      },
      TEST_ENV,
    );
    expect(lookup.status).toBe(200);
    const lookupBody = await lookup.json();
    expect(lookupBody).toEqual({
      ok: true,
      data: { deleted: true, deleted_at: rows[0]!.deleted_at },
    });

    await sql.unsafe(`DELETE FROM account_deletion_receipts WHERE receipt_hash = $1`, [hash]);
  });

  it('returns receipt_not_found for an unknown unauthenticated capability', async () => {
    const app = createApp(TEST_ENV);
    const lookup = await app.request(
      '/api/account-deletion/receipts/lookup',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receipt_token: uid('unknown-receipt') }),
      },
      TEST_ENV,
    );

    expect(lookup.status).toBe(404);
    const body = await lookup.json();
    expect(body).toEqual({
      ok: false,
      error: { code: 'receipt_not_found', message: expect.any(String) },
    });
  });

  it('rolls back account deletion when the receipt hash already exists', async () => {
    const { userId, sessionToken } = await seedUser();
    const app = createApp(TEST_ENV);
    const hash = receiptHash(uid('duplicate-receipt'));
    const now = Date.now();
    await sql.unsafe(
      `INSERT INTO account_deletion_receipts
          (receipt_hash, deleted_user_id, deleted_at, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [hash, 'already-deleted-user', now, now + 30 * 24 * 60 * 60 * 1000],
    );

    const res = await deleteMe(
      app,
      sessionToken,
      {
        cloudkit_disposition: 'no_cloudkit_garden',
        deletion_receipt_hash: hash,
      },
      false,
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      ok: false,
      error: { code: 'deletion_receipt_conflict', message: expect.any(String) },
    });

    const userRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM "user" WHERE id = $1`,
      [userId],
    );
    expect(userRows).toEqual([{ id: userId }]);

    await sql.unsafe(`DELETE FROM account_deletion_receipts WHERE receipt_hash = $1`, [hash]);
    await sql.unsafe(`DELETE FROM "user" WHERE id = $1`, [userId]);
  });

  it('requires a lowercase SHA-256 deletion receipt hash', async () => {
    const { userId, sessionToken } = await seedUser();
    const app = createApp(TEST_ENV);

    for (const body of [
      { cloudkit_disposition: 'no_cloudkit_garden' },
      {
        cloudkit_disposition: 'no_cloudkit_garden',
        deletion_receipt_hash: 'not-a-sha256-hash',
      },
    ]) {
      const res = await deleteMe(app, sessionToken, body, false);
      expect(res.status).toBe(400);
      const responseBody = await res.json();
      expect(responseBody).toEqual({
        ok: false,
        error: { code: 'deletion_receipt_required', message: expect.any(String) },
      });
    }

    const userRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM "user" WHERE id = $1`,
      [userId],
    );
    expect(userRows).toEqual([{ id: userId }]);
    await sql.unsafe(`DELETE FROM "user" WHERE id = $1`, [userId]);
  });

  it('does not write a receipt when the CloudKit transfer gate blocks deletion', async () => {
    const { userId: ownerId, sessionToken } = await seedUser();
    const { userId: memberId } = await seedUser();
    const householdId = await seedHousehold();
    await addMembership(householdId, ownerId, 'owner');
    await addMembership(householdId, memberId, 'member', 1000);
    const app = createApp(TEST_ENV);
    const hash = receiptHash(uid('blocked-receipt'));

    const res = await deleteMe(
      app,
      sessionToken,
      {
        cloudkit_disposition: 'transfer_source_deleted',
        transfer_id: 'missing-transfer',
        deletion_receipt_hash: hash,
      },
      false,
    );
    expect(res.status).toBe(409);

    const receipts = await sql.unsafe<{ receipt_hash: string }[]>(
      `SELECT receipt_hash FROM account_deletion_receipts WHERE receipt_hash = $1`,
      [hash],
    );
    expect(receipts).toHaveLength(0);
    const ownerRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM "user" WHERE id = $1`,
      [ownerId],
    );
    expect(ownerRows).toEqual([{ id: ownerId }]);

    await sql.unsafe(`DELETE FROM memberships WHERE household_id = $1`, [householdId]);
    await sql.unsafe(`DELETE FROM households WHERE id = $1`, [householdId]);
    await sql.unsafe(`DELETE FROM "user" WHERE id IN ($1, $2)`, [ownerId, memberId]);
  });
});

// ── (e) Caller belongs to more than one household ─────────────────────────

/**
 * A transfer successor is re-homed into the departing owner's household
 * while keeping their original one, so from Task 1 onward a single user
 * can hold several memberships. Deleting that account must dispose of
 * every one of them, not just the most recently joined.
 */
describe('DELETE /api/me — caller with multiple memberships', () => {
  it('hard-deletes every sole-member household and collects photos from all of them', async () => {
    deletedKeys.length = 0;

    const { userId, sessionToken } = await seedUser();
    // `original` is the older membership; `rehomed` mimics the newest
    // membership a verified handoff UPSERTs onto the successor.
    const original = await seedHousehold();
    const rehomed = await seedHousehold();
    await addMembership(original, userId, 'owner', -60_000);
    await addMembership(rehomed, userId, 'owner', 0);

    const originalKey = await seedSeedWithPhoto(original);
    const rehomedKey = await seedSeedWithPhoto(rehomed);

    const app = createApp(TEST_ENV);
    const res = await deleteMe(app, sessionToken, {
      cloudkit_disposition: 'owner_zone_deleted',
    });
    expect(res.status).toBe(200);

    expect(await householdExists(original)).toBe(false);
    expect(await householdExists(rehomed)).toBe(false);
    expect(await membershipsOf(userId)).toEqual([]);

    const userRows = await sql.unsafe<{ id: string }[]>(`SELECT id FROM "user" WHERE id = $1`, [
      userId,
    ]);
    expect(userRows).toEqual([]);

    expect([...deletedKeys].sort()).toEqual([originalKey, rehomedKey].sort());
  });

  it('applies the disposal rule household by household: delete, promote, and step out', async () => {
    deletedKeys.length = 0;

    const { userId, sessionToken } = await seedUser();
    const { userId: heirId } = await seedUser();
    const { userId: coOwnerId } = await seedUser();

    const soleHousehold = await seedHousehold();
    const onlyOwnerHousehold = await seedHousehold();
    const coOwnedHousehold = await seedHousehold();

    await addMembership(soleHousehold, userId, 'owner', -90_000);
    await addMembership(onlyOwnerHousehold, userId, 'owner', -60_000);
    await addMembership(onlyOwnerHousehold, heirId, 'member', -30_000);
    await addMembership(coOwnedHousehold, coOwnerId, 'owner', -20_000);
    await addMembership(coOwnedHousehold, userId, 'member', 0);

    const soleKey = await seedSeedWithPhoto(soleHousehold);
    const survivingKey = await seedSeedWithPhoto(onlyOwnerHousehold);

    const app = createApp(TEST_ENV);
    const res = await deleteMe(app, sessionToken, {
      cloudkit_disposition: 'owner_zone_deleted',
    });
    expect(res.status).toBe(200);

    // Sole-member household: gone, photos reclaimed.
    expect(await householdExists(soleHousehold)).toBe(false);

    // Only-owner household: survives, oldest remaining member promoted.
    expect(await householdExists(onlyOwnerHousehold)).toBe(true);
    const promoted = await sql.unsafe<{ user_id: string; role: string }[]>(
      `SELECT user_id, role FROM memberships WHERE household_id = $1`,
      [onlyOwnerHousehold],
    );
    expect(promoted).toEqual([{ user_id: heirId, role: 'owner' }]);

    // Co-owned household: survives untouched apart from the caller leaving.
    expect(await householdExists(coOwnedHousehold)).toBe(true);
    const remaining = await sql.unsafe<{ user_id: string; role: string }[]>(
      `SELECT user_id, role FROM memberships WHERE household_id = $1`,
      [coOwnedHousehold],
    );
    expect(remaining).toEqual([{ user_id: coOwnerId, role: 'owner' }]);

    expect(await membershipsOf(userId)).toEqual([]);
    expect(deletedKeys).toEqual([soleKey]);
    expect(deletedKeys).not.toContain(survivingKey);

    await sql.unsafe(`DELETE FROM memberships WHERE household_id = ANY($1)`, [
      [onlyOwnerHousehold, coOwnedHousehold],
    ]);
    await sql.unsafe(`DELETE FROM households WHERE id = ANY($1)`, [
      [onlyOwnerHousehold, coOwnedHousehold],
    ]);
    await sql.unsafe(`DELETE FROM "user" WHERE id = ANY($1)`, [[heirId, coOwnerId]]);
  });

  it('disposes of nothing anywhere when the CloudKit transfer gate blocks the deletion', async () => {
    deletedKeys.length = 0;

    const { userId, sessionToken } = await seedUser();
    const transferHousehold = await seedHousehold();
    const otherHousehold = await seedHousehold();
    await addMembership(transferHousehold, userId, 'owner', -60_000);
    await addMembership(otherHousehold, userId, 'owner', 0);

    const now = Date.now();
    const transferId = uid('ad-xfer');
    await sql.unsafe(
      `INSERT INTO account_deletion_transfers
         (id, source_household_id, owner_user_id, handoff_token_hash,
          handoff_expires_at, phase, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'pending_successor', $6, $6)`,
      [transferId, transferHousehold, userId, `hash-${transferId}`, now + 3_600_000, now],
    );

    const app = createApp(TEST_ENV);
    const res = await deleteMe(app, sessionToken, {
      cloudkit_disposition: 'owner_zone_deleted',
    });
    expect(res.status).toBe(409);
    const blocked = (await res.json()) as { error: { code: string } };
    expect(blocked.error.code).toBe('cloudkit_transfer_required');

    // Both memberships and both households survive the refusal intact.
    expect((await membershipsOf(userId)).sort()).toEqual(
      [transferHousehold, otherHousehold].sort(),
    );
    expect(await householdExists(transferHousehold)).toBe(true);
    expect(await householdExists(otherHousehold)).toBe(true);
    expect(deletedKeys).toEqual([]);

    await sql.unsafe(`DELETE FROM account_deletion_transfers WHERE id = $1`, [transferId]);
    await sql.unsafe(`DELETE FROM memberships WHERE user_id = $1`, [userId]);
    await sql.unsafe(`DELETE FROM households WHERE id = ANY($1)`, [
      [transferHousehold, otherHousehold],
    ]);
    await sql.unsafe(`DELETE FROM "user" WHERE id = $1`, [userId]);
  });
});

// ── (f) The last two members delete at the same time ──────────────────────

describe('DELETE /api/me — last two members deleting concurrently', () => {
  it('never leaves the household behind with zero members', async () => {
    deletedKeys.length = 0;

    const owner = await seedUser();
    const member = await seedUser();
    const householdId = await seedHousehold();
    await addMembership(householdId, owner.userId, 'owner', -10_000);
    await addMembership(householdId, member.userId, 'member', 0);

    const app = createApp(TEST_ENV);
    const [a, b] = await Promise.all([
      deleteMe(app, owner.sessionToken, { cloudkit_disposition: 'owner_zone_deleted' }),
      deleteMe(app, member.sessionToken, { cloudkit_disposition: 'participant_left_share' }),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const survivors = await sql.unsafe<{ user_id: string }[]>(
      `SELECT user_id FROM memberships WHERE household_id = $1`,
      [householdId],
    );
    expect(survivors).toEqual([]);
    expect(await householdExists(householdId)).toBe(false);

    const users = await sql.unsafe<{ id: string }[]>(`SELECT id FROM "user" WHERE id = ANY($1)`, [
      [owner.userId, member.userId],
    ]);
    expect(users).toEqual([]);
  });
});

// ── Receipt expiry and lookup rate limiting ───────────────────────────────

describe('account-deletion receipt lookup — expiry and rate limiting', () => {
  it('treats an expired receipt exactly like an unknown one', async () => {
    const app = createApp(TEST_ENV);
    const rawReceipt = uid('expired-receipt');
    const hash = receiptHash(rawReceipt);
    const now = Date.now();
    await sql.unsafe(
      `INSERT INTO account_deletion_receipts
          (receipt_hash, deleted_user_id, deleted_at, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [hash, 'ad-user-long-gone', now - 31 * 24 * 60 * 60 * 1000, now - 1000],
    );

    // The miss budget is per client and lives for an hour, so every test
    // takes a fresh bucket — repeated runs in one process stay identical.
    const expired = await lookupReceipt(app, rawReceipt, uid('client-expired'));
    const unknown = await lookupReceipt(app, uid('never-issued'), uid('client-unknown'));

    expect(expired.status).toBe(404);
    expect(await expired.json()).toEqual(await unknown.json());

    await sql.unsafe(`DELETE FROM account_deletion_receipts WHERE receipt_hash = $1`, [hash]);
  });

  it('rate limits repeated misses from one client without penalising a real receipt', async () => {
    const app = createApp(TEST_ENV);
    const attacker = uid('client-attacker');

    // A real receipt, held by a well-behaved client on another address.
    const { sessionToken } = await seedUser();
    const rawReceipt = uid('rl-receipt');
    const deleted = await deleteMe(
      app,
      sessionToken,
      {
        cloudkit_disposition: 'no_cloudkit_garden',
        deletion_receipt_hash: receiptHash(rawReceipt),
      },
      false,
    );
    expect(deleted.status).toBe(200);

    let limitedAt = -1;
    for (let i = 0; i < 25; i += 1) {
      const res = await lookupReceipt(app, uid('guess'), attacker);
      if (res.status === 429) {
        const body = (await res.json()) as {
          ok: boolean;
          error: { code: string };
          retry_after_seconds: number;
        };
        expect(body.ok).toBe(false);
        expect(body.error.code).toBe('rate_limited');
        expect(body.retry_after_seconds).toBe(3600);
        limitedAt = i;
        break;
      }
      expect(res.status).toBe(404);
    }
    // Exactly 20 misses are free; the 21st (index 20) is refused.
    expect(limitedAt).toBe(20);

    // A different client is unaffected, and a hit does not consume budget.
    const holder = uid('client-holder');
    for (let i = 0; i < 3; i += 1) {
      const hit = await lookupReceipt(app, rawReceipt, holder);
      expect(hit.status).toBe(200);
      const hitBody = (await hit.json()) as { data: { deleted: boolean } };
      expect(hitBody.data.deleted).toBe(true);
    }

    await sql.unsafe(`DELETE FROM account_deletion_receipts WHERE receipt_hash = $1`, [
      receiptHash(rawReceipt),
    ]);
  });
});
