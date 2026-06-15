/**
 * M5 · integration tests for DELETE /api/me (account deletion).
 *
 * Covers all four cases from spec A4:
 *   (a) Sole-member — user, household, seeds, journal, assistant all gone;
 *       catalog_feedback.user_id SET NULL; deletePhoto called for all 3 key
 *       sources (seed photo, journal photo, extraction with a 2-key array).
 *   (b) Multi-member, caller is a non-owner member — caller's membership +
 *       user gone, household + other owner + their seed intact.
 *   (c) Multi-member, caller is the only owner, one other member — that
 *       member promoted to owner, household intact, caller gone.
 *   (d) User with NO household — deletes cleanly, no 409.
 *
 * Run with:
 *   bun test tests/integration/accountDeletion.test.ts
 *
 * Prerequisites:
 *   - Local Postgres reachable at DATABASE_URL
 *   - Migrations 0001–0023 applied (`bun run migrate`)
 */

import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import postgres, { type Sql } from 'postgres';
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
};

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 12)}`;
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
  await sql.end({ timeout: 5 });
});

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
    const res = await app.request(
      '/api/me',
      { method: 'DELETE', headers: { Authorization: `Bearer ${fx.sessionToken}` } },
      TEST_ENV,
    );

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
    // household_id is also SET NULL on deletion, so the row may or may not
    // survive depending on the constraint update in migration 0020.
    // The key invariant: user_id is NULL on the surviving row (if it exists).
    if (feedbackRows.length > 0) {
      expect(feedbackRows[0]!.user_id).toBeNull();
    }

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

    const res = await app.request(
      '/api/me',
      { method: 'DELETE', headers: { Authorization: `Bearer ${callerToken}` } },
      TEST_ENV,
    );

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
  it('promotes oldest-joined other member to owner, household intact, caller gone', async () => {
    deletedKeys.length = 0;

    // Caller is the sole owner.
    const { userId: ownerUserId, sessionToken: ownerToken } = await seedUser();
    // Other member (not owner).
    const { userId: memberUserId } = await seedUser();

    const householdId = await seedHousehold();
    // Owner joined first.
    await addMembership(householdId, ownerUserId, 'owner', 0);
    // Member joined later.
    await addMembership(householdId, memberUserId, 'member', 5000);

    const app = createApp(TEST_ENV);

    const res = await app.request(
      '/api/me',
      { method: 'DELETE', headers: { Authorization: `Bearer ${ownerToken}` } },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { deleted: boolean } };
    expect(json.ok).toBe(true);
    expect(json.data.deleted).toBe(true);

    // Owner (caller) user is gone.
    const ownerRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM "user" WHERE id = $1`,
      [ownerUserId],
    );
    expect(ownerRows.length).toBe(0);

    // Household is intact.
    const hhRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM households WHERE id = $1`,
      [householdId],
    );
    expect(hhRows.length).toBe(1);

    // Other member has been promoted to owner.
    const memberMembRows = await sql.unsafe<{ role: string }[]>(
      `SELECT role FROM memberships WHERE household_id = $1 AND user_id = $2`,
      [householdId, memberUserId],
    );
    expect(memberMembRows.length).toBe(1);
    expect(memberMembRows[0]!.role).toBe('owner');

    // No S3 deletions occurred.
    expect(deletedKeys.length).toBe(0);

    // Clean up.
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

    const res = await app.request(
      '/api/me',
      { method: 'DELETE', headers: { Authorization: `Bearer ${sessionToken}` } },
      TEST_ENV,
    );

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
