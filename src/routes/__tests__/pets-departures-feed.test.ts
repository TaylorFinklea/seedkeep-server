/**
 * Integration tests for GET /api/pets/departures.
 *
 * Mirrors the DB-integration scaffolding from `pets-depart.test.ts`:
 * seed the minimal auth chain (user → session → household → membership),
 * insert pet_departures rows directly with SQL, then hit the route through
 * the Hono app and assert on the delta-sync envelope shape.
 *
 * Coverage map (mirrors the journal.ts delta-sync coverage):
 *   - Empty feed for a fresh household
 *   - Inserted row surfaces with the wire DTO shape
 *   - Cross-household isolation (household A's row never appears in B)
 *   - since=0 hides tombstones; since>0 includes them
 *   - has_more cursoring under limit
 *
 * No Anthropic mocking — the read path doesn't touch Sprout.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createApp } from '../../index';
import type { Env } from '../../env';

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

const cleanup = {
  userIds: new Set<string>(),
  householdIds: new Set<string>(),
};

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 12)}`;
}

interface Fixture {
  userId: string;
  householdId: string;
  sessionToken: string;
}

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

  await sql.unsafe(
    `INSERT INTO session (id, "expiresAt", token, "createdAt", "updatedAt",
                          "ipAddress", "userAgent", "userId")
     VALUES ($1, NOW() + INTERVAL '1 day', $2, NOW(), NOW(), NULL, NULL, $3)`,
    [sessionId, sessionToken, userId],
  );

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

interface SeedPlantingOpts {
  householdId: string;
  petName?: string;
}

async function seedPlanting(opts: SeedPlantingOpts): Promise<{ id: string }> {
  const id = uid('pe');
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO planting_events (
       id, household_id, kind, planned_for, created_at, updated_at,
       pet_seed, pet_rarity, pet_creature_kind, pet_name,
       pet_personality, pet_spawned_at
     ) VALUES ($1, $2, 'sowing', '2026-06-15', $3, $3,
               $4, 'common', 'garden_worm', $5, $6, $3)`,
    [
      id,
      opts.householdId,
      now,
      `seed-${id}`,
      opts.petName ?? 'Mossling',
      JSON.stringify({ name: opts.petName ?? 'Mossling' }),
    ],
  );
  return { id };
}

interface SeedDepartureOpts {
  plantingEventId: string;
  householdId: string;
  /** Override the row's `updated_at` (and `created_at`/`departed_at`). */
  updatedAt?: number;
  /** When set, marks the departure as soft-deleted at this timestamp. */
  deletedAt?: number;
  reason?: 'inactivity' | 'wilted_too_long' | 'user_dismissed';
}

async function seedDeparture(opts: SeedDepartureOpts): Promise<void> {
  const ts = opts.updatedAt ?? Date.now();
  await sql.unsafe(
    `INSERT INTO pet_departures
       (planting_event_id, household_id, goodbye_note, reason,
        departed_at, created_at, updated_at, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $5, $5, $6)`,
    [
      opts.plantingEventId,
      opts.householdId,
      JSON.stringify({
        note_text: "I'll miss you.",
        signoff: '— Mossling',
        fallback: false,
        fallback_attempts: 0,
        last_attempt_at: ts,
      }),
      opts.reason ?? 'wilted_too_long',
      ts,
      opts.deletedAt ?? null,
    ],
  );
}

interface DepartureWire {
  planting_event_id: string;
  household_id: string;
  goodbye_note: string | null;
  reason: string;
  departed_at: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface DeltaEnvelope {
  ok: boolean;
  data: {
    items: DepartureWire[];
    cursor: number;
    has_more: boolean;
  };
}

beforeAll(async () => {
  await sql`SELECT 1`;
});

afterAll(async () => {
  for (const id of cleanup.householdIds) {
    await sql.unsafe(`DELETE FROM households WHERE id = $1`, [id]).catch(() => {});
  }
  for (const id of cleanup.userIds) {
    await sql.unsafe(`DELETE FROM "user" WHERE id = $1`, [id]).catch(() => {});
  }
  await sql.end({ timeout: 5 });
});

async function getFeed(
  app: ReturnType<typeof createApp>,
  fx: Fixture,
  qs: string,
): Promise<DeltaEnvelope> {
  const res = await app.request(
    `/api/pets/departures${qs}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${fx.sessionToken}` },
    },
    TEST_ENV,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as DeltaEnvelope;
}

describe('GET /api/pets/departures — empty feed', () => {
  it('returns empty items + cursor=0 for a fresh household', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);

    const json = await getFeed(app, fx, '?since=0');
    expect(json.ok).toBe(true);
    expect(json.data.items).toEqual([]);
    expect(json.data.cursor).toBe(0);
    expect(json.data.has_more).toBe(false);
  });
});

describe('GET /api/pets/departures — populated feed', () => {
  it('surfaces an inserted departure row with the wire DTO shape', async () => {
    const fx = await seedAuthFixture();
    const planting = await seedPlanting({ householdId: fx.householdId });
    const ts = Date.now();
    await seedDeparture({
      plantingEventId: planting.id,
      householdId: fx.householdId,
      updatedAt: ts,
    });

    const app = createApp(TEST_ENV);
    const json = await getFeed(app, fx, '?since=0');

    expect(json.data.items).toHaveLength(1);
    const row = json.data.items[0];
    expect(row.planting_event_id).toBe(planting.id);
    expect(row.household_id).toBe(fx.householdId);
    expect(row.reason).toBe('wilted_too_long');
    expect(row.updated_at).toBe(ts);
    expect(row.departed_at).toBe(ts);
    expect(row.deleted_at).toBeNull();
    expect(typeof row.goodbye_note).toBe('string');
    // goodbye_note is raw TEXT holding JSON; the client decodes.
    const note = JSON.parse(row.goodbye_note!) as { note_text: string };
    expect(note.note_text).toBe("I'll miss you.");

    expect(json.data.cursor).toBe(ts);
    expect(json.data.has_more).toBe(false);
  });
});

describe('GET /api/pets/departures — cross-household isolation', () => {
  it("does not return household A's row in B's feed", async () => {
    const ownerA = await seedAuthFixture();
    const ownerB = await seedAuthFixture();
    const planting = await seedPlanting({ householdId: ownerA.householdId });
    await seedDeparture({
      plantingEventId: planting.id,
      householdId: ownerA.householdId,
    });

    const app = createApp(TEST_ENV);
    const jsonA = await getFeed(app, ownerA, '?since=0');
    const jsonB = await getFeed(app, ownerB, '?since=0');

    expect(jsonA.data.items.map((r) => r.planting_event_id)).toContain(planting.id);
    expect(jsonB.data.items).toEqual([]);
  });
});

describe('GET /api/pets/departures — tombstone handling', () => {
  it('since=0 hides soft-deleted rows; since>0 includes them', async () => {
    const fx = await seedAuthFixture();
    const liveP = await seedPlanting({ householdId: fx.householdId, petName: 'Alive' });
    const deadP = await seedPlanting({ householdId: fx.householdId, petName: 'Gone' });

    const t1 = 1_700_000_000_000;
    const t2 = 1_700_000_001_000;
    await seedDeparture({
      plantingEventId: liveP.id,
      householdId: fx.householdId,
      updatedAt: t1,
    });
    await seedDeparture({
      plantingEventId: deadP.id,
      householdId: fx.householdId,
      updatedAt: t2,
      deletedAt: t2,
    });

    const app = createApp(TEST_ENV);

    // since=0 — initial pull, must not expose tombstones.
    const initial = await getFeed(app, fx, '?since=0');
    const initialIds = initial.data.items.map((r) => r.planting_event_id);
    expect(initialIds).toContain(liveP.id);
    expect(initialIds).not.toContain(deadP.id);

    // since>0 — delta pull, must include the tombstone so the client can
    // cascade `LocalPetDeparture` deletes.
    const delta = await getFeed(app, fx, `?since=${t1 - 1}`);
    const deltaIds = delta.data.items.map((r) => r.planting_event_id);
    expect(deltaIds).toContain(liveP.id);
    expect(deltaIds).toContain(deadP.id);
    const tomb = delta.data.items.find((r) => r.planting_event_id === deadP.id);
    expect(tomb?.deleted_at).toBe(t2);
  });
});

describe('GET /api/pets/departures — pagination', () => {
  it('honours limit and reports has_more + correct cursor for the next pull', async () => {
    const fx = await seedAuthFixture();
    const base = 1_710_000_000_000;
    // Seed 3 plantings + 3 departures with monotonically increasing updated_at.
    const plantings: { id: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const p = await seedPlanting({ householdId: fx.householdId, petName: `P${i}` });
      plantings.push(p);
      await seedDeparture({
        plantingEventId: p.id,
        householdId: fx.householdId,
        updatedAt: base + i,
      });
    }

    const app = createApp(TEST_ENV);

    // Page 1: limit=2 — must yield the two oldest rows and `has_more=true`.
    const page1 = await getFeed(app, fx, '?since=0&limit=2');
    expect(page1.data.items).toHaveLength(2);
    expect(page1.data.items.map((r) => r.planting_event_id)).toEqual([
      plantings[0].id,
      plantings[1].id,
    ]);
    expect(page1.data.has_more).toBe(true);
    expect(page1.data.cursor).toBe(base + 1);

    // Page 2: resume from the cursor — the third row, no more after it.
    const page2 = await getFeed(app, fx, `?since=${page1.data.cursor}&limit=2`);
    expect(page2.data.items).toHaveLength(1);
    expect(page2.data.items[0].planting_event_id).toBe(plantings[2].id);
    expect(page2.data.has_more).toBe(false);
    expect(page2.data.cursor).toBe(base + 2);
  });
});
