/**
 * Integration test for the Phase 5.1.0 default-journal-seeding behavior
 * on `POST /api/planting-events`. Mirrors the DB-integration pattern in
 * `src/__tests__/worker.test.ts` — connects to a local Postgres
 * (DATABASE_URL or the dev default), seeds the minimal auth fixtures
 * (user, session, household, membership), then exercises the Hono app
 * via `app.request()`.
 *
 * Why an HTTP-level test: the seeding is a side-effect of the POST
 * handler. Verifying the resulting `journal_entries` +
 * `journal_checklist_items` rows after a real request gives us
 * confidence the wiring matches the route — not just that the helper
 * functions agree.
 *
 * Anthropic spawn path: the test does NOT configure ASSISTANT_KEY_MASTER
 * or the household's `assistant_keys` row, so `loadAnthropicKey` returns
 * null and `spawnPet` deterministically falls back. The journal seeding
 * runs after the INSERT regardless of the spawn outcome.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { nanoid } from 'nanoid';
import { createApp } from '../../index';
import type { Env } from '../../env';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://seedkeep:dev-only@localhost:5432/seedkeep';

// Connection used by the test for fixture setup + post-condition queries.
// The Hono app opens its own pool via `getSql(env)`; both pools point at
// the same DB, so writes from the route handler are visible here.
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

// Fixture env — satisfies env.ts's zod schema with dummy values. S3 +
// Apple credentials never get touched by this test (we hit only the
// planting-events + journal routes), and `ASSISTANT_KEY_MASTER` is
// intentionally omitted so spawnPet falls back without an Anthropic call.
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
  ASSISTANT_KEY_MASTER: undefined,
  DEFAULT_VISION_MODEL: 'claude-sonnet-4-6',
  DEFAULT_REVIEW_MODEL: 'claude-haiku-4-5-20251001',
  ADMIN_SECRET: undefined,
};

// IDs created by each test; tracked for cleanup in afterAll.
const cleanup = {
  userIds: new Set<string>(),
  householdIds: new Set<string>(),
  sessionIds: new Set<string>(),
  plantingEventIds: new Set<string>(),
};

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 12)}`;
}

interface Fixture {
  userId: string;
  householdId: string;
  sessionToken: string;
}

/**
 * Seed the minimal auth chain: user → session (active, future expiry)
 * → household → membership (owner). Returns the bearer token the test
 * uses on subsequent requests.
 */
async function seedAuthFixture(): Promise<Fixture> {
  const userId = uid('test-user');
  const householdId = uid('test-hh');
  const sessionId = uid('test-sess');
  const sessionToken = uid('test-tok');
  const now = Date.now();

  await sql.unsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'Test User', $2, TRUE, $3, $3)`,
    [userId, `${userId}@example.invalid`, now],
  );
  cleanup.userIds.add(userId);

  // expiresAt is TIMESTAMPTZ post-migration-0003; use a future timestamp.
  await sql.unsafe(
    `INSERT INTO session (id, "expiresAt", token, "createdAt", "updatedAt",
                          "ipAddress", "userAgent", "userId")
     VALUES ($1, NOW() + INTERVAL '1 day', $2, NOW(), NOW(), NULL, NULL, $3)`,
    [sessionId, sessionToken, userId],
  );
  cleanup.sessionIds.add(sessionId);

  await sql.unsafe(
    `INSERT INTO households (id, name, created_at, updated_at)
     VALUES ($1, 'Test Household', $2, $2)`,
    [householdId, now],
  );
  cleanup.householdIds.add(householdId);

  await sql.unsafe(
    `INSERT INTO memberships (household_id, user_id, role, joined_at)
     VALUES ($1, $2, 'owner', $3)`,
    [householdId, userId, now],
  );

  return { userId, householdId, sessionToken };
}

beforeAll(async () => {
  // Make sure the DB is reachable up-front; if not, every test will
  // fail with the same ECONNREFUSED — that's the precondition.
  await sql`SELECT 1`;
});

afterAll(async () => {
  // CASCADE removes session, memberships, planting_events,
  // journal_entries, journal_checklist_items from these households.
  for (const id of cleanup.householdIds) {
    await sql.unsafe(`DELETE FROM households WHERE id = $1`, [id]).catch(() => {});
  }
  for (const id of cleanup.userIds) {
    await sql.unsafe(`DELETE FROM "user" WHERE id = $1`, [id]).catch(() => {});
  }
  await sql.end({ timeout: 5 });
});

describe('POST /api/planting-events — default journal+checklist seeding', () => {
  it('creates a journal entry with a single unchecked "Watered" checklist item linked to the new planting', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);

    const res = await app.request(
      '/api/planting-events',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({
          kind: 'sowing',
          planned_for: '2026-06-15',
        }),
      },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { planting_event: { id: string; household_id: string } };
    };
    expect(json.ok).toBe(true);
    const plantingEventId = json.data.planting_event.id;
    cleanup.plantingEventIds.add(plantingEventId);
    expect(json.data.planting_event.household_id).toBe(fx.householdId);

    // Post-condition #1: exactly one journal entry pointing at the new
    // planting event, with the household scoped correctly and an empty
    // body (the checklist item is the payload).
    interface EntryRow {
      id: string;
      household_id: string;
      body: string;
      occurred_on: string;
      deleted_at: number | null;
    }
    const entries = await sql.unsafe<EntryRow[]>(
      `SELECT id, household_id, body, occurred_on::text AS occurred_on, deleted_at
         FROM journal_entries
        WHERE planting_event_id = $1`,
      [plantingEventId],
    );
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.household_id).toBe(fx.householdId);
    expect(entry.body).toBe('');
    expect(entry.occurred_on).toBe('2026-06-15');
    expect(entry.deleted_at).toBeNull();

    // Post-condition #2: exactly one checklist item, labeled "Watered",
    // unchecked, sort_order 0, attached to the seeded entry.
    interface ChecklistRow {
      id: string;
      entry_id: string;
      text: string;
      completed: boolean;
      sort_order: number;
    }
    const items = await sql.unsafe<ChecklistRow[]>(
      `SELECT id, entry_id, text, completed, sort_order
         FROM journal_checklist_items
        WHERE entry_id = $1`,
      [entry.id],
    );
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.entry_id).toBe(entry.id);
    expect(item.text).toBe('Watered');
    expect(item.completed).toBe(false);
    expect(item.sort_order).toBe(0);

    // Post-condition #3: GET /api/journal returns the seeded entry.
    // Filter by `planting_event_id` so other parallel tests don't bleed
    // in. since=0 hides soft-deletes, which is what we want here.
    const listRes = await app.request(
      `/api/journal?planting_event_id=${plantingEventId}&since=0`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${fx.sessionToken}` },
      },
      TEST_ENV,
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      ok: boolean;
      data: {
        items: Array<{
          id: string;
          plantingEventId: string | null;
          body: string;
        }>;
      };
    };
    expect(listJson.ok).toBe(true);
    expect(listJson.data.items).toHaveLength(1);
    expect(listJson.data.items[0]!.id).toBe(entry.id);
    expect(listJson.data.items[0]!.plantingEventId).toBe(plantingEventId);
  });

  it('does not create stray journal entries when a planting create succeeds (exactly one entry, one item)', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);

    // Two back-to-back creates — each should seed its own entry/item
    // pair, with no cross-contamination.
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await app.request(
        '/api/planting-events',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${fx.sessionToken}`,
          },
          body: JSON.stringify({
            kind: 'sowing',
            planned_for: '2026-07-01',
          }),
        },
        TEST_ENV,
      );
      const json = (await res.json()) as {
        data: { planting_event: { id: string } };
      };
      const pid = json.data.planting_event.id;
      ids.push(pid);
      cleanup.plantingEventIds.add(pid);
    }

    for (const pid of ids) {
      const entries = await sql.unsafe<{ id: string }[]>(
        `SELECT id FROM journal_entries WHERE planting_event_id = $1`,
        [pid],
      );
      expect(entries).toHaveLength(1);
      const items = await sql.unsafe<{ text: string }[]>(
        `SELECT text FROM journal_checklist_items WHERE entry_id = $1`,
        [entries[0]!.id],
      );
      expect(items).toHaveLength(1);
      expect(items[0]!.text).toBe('Watered');
    }
  });
});
