/**
 * Integration tests for POST /api/pets/:planting_event_id/depart.
 *
 * Mirrors the DB-integration shape used by `planting-events-pet.test.ts`:
 * connect to a local Postgres (DATABASE_URL or dev default), seed the
 * minimal auth chain (user → session → household → membership), POST
 * through the Hono app, and assert on both response shape and persisted
 * `pet_departures` rows.
 *
 * Anthropic is mocked by `__setDepartureCallerForTests` so the tests
 * don't hit the network. The mock counts invocations so the idempotent
 * branch can assert "no second Sprout call".
 *
 * ASSISTANT_KEY_MASTER + an `assistant_keys` row are configured so the
 * route uses the mocked caller; if the env+row were omitted, the route
 * would skip Sprout entirely and route through the deterministic
 * fallback path (still valid behaviour, but it wouldn't exercise the
 * success branch).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { randomBytes } from 'node:crypto';
import { createApp } from '../../index';
import type { Env } from '../../env';
import { __setDepartureCallerForTests, type DepartureAnthropicCaller } from '../pets';
import { encryptApiKey } from '../../lib/assistant/keyEncryption';

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

// ASSISTANT_KEY_MASTER is base64(32 random bytes). Generated per test
// run; the underlying key material never leaves the test process.
const TEST_MASTER_KEY = randomBytes(32).toString('base64');

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

  // Configure a BYOK Anthropic key so the route loads it and reaches the
  // mocked caller. The cipher text is dummy bytes; the mock caller never
  // actually validates the key, only checks it's non-null.
  const encrypted = encryptApiKey('sk-test-fake-key', TEST_MASTER_KEY);
  await sql.unsafe(
    `INSERT INTO assistant_keys
       (household_id, provider, encrypted_key, key_iv, key_tag,
        created_at, updated_at)
     VALUES ($1, 'anthropic', $2, $3, $4, $5, $5)`,
    [householdId, encrypted.ciphertext, encrypted.iv, encrypted.tag, now],
  );

  return { userId, householdId, sessionToken };
}

interface SeedPlantingOpts {
  householdId: string;
  /** When provided, sets planting_events.completed_at — graduated path. */
  completedAt?: number | null;
  /** Override pet identity columns; defaults to a fixture-spawned pet. */
  petName?: string;
  petPersonality?: Record<string, unknown>;
}

async function seedPlanting(opts: SeedPlantingOpts): Promise<{ id: string }> {
  const id = uid('pe');
  const now = Date.now();
  const personality = JSON.stringify(
    opts.petPersonality ?? {
      name: opts.petName ?? 'Mossling',
      vignette: 'A small companion who watches the rows.',
      voice_hint: 'speaks in short observations',
      traits: [],
      tone: '',
      version: 1,
      fallback: false,
      fallback_attempts: 0,
      last_attempt_at: now,
    },
  );
  await sql.unsafe(
    `INSERT INTO planting_events (
       id, household_id, kind, planned_for, created_at, updated_at,
       completed_at,
       pet_seed, pet_rarity, pet_creature_kind, pet_name,
       pet_personality, pet_spawned_at
     ) VALUES ($1, $2, 'sowing', '2026-06-15', $3, $3,
               $4,
               $5, 'common', 'garden_worm', $6,
               $7, $3)`,
    [
      id,
      opts.householdId,
      now,
      opts.completedAt ?? null,
      `seed-${id}`,
      opts.petName ?? 'Mossling',
      personality,
    ],
  );
  return { id };
}

beforeAll(async () => {
  await sql`SELECT 1`;
});

afterAll(async () => {
  __setDepartureCallerForTests(null);
  for (const id of cleanup.householdIds) {
    await sql.unsafe(`DELETE FROM households WHERE id = $1`, [id]).catch(() => {});
  }
  for (const id of cleanup.userIds) {
    await sql.unsafe(`DELETE FROM "user" WHERE id = $1`, [id]).catch(() => {});
  }
  await sql.end({ timeout: 5 });
});

beforeEach(() => {
  // Reset the mock between tests so call-count assertions are isolated.
  __setDepartureCallerForTests(null);
});

function makeNoteResponse(noteText: string, signoff: string): string {
  return JSON.stringify({ note_text: noteText, signoff });
}

describe('POST /api/pets/:planting_event_id/depart — success', () => {
  it('returns 200 with the goodbye note + departure row populated', async () => {
    const fx = await seedAuthFixture();
    const planting = await seedPlanting({ householdId: fx.householdId });
    const app = createApp(TEST_ENV);

    const calls: Array<{ system: string; userText: string }> = [];
    const mock: DepartureAnthropicCaller = async ({ system, userText }) => {
      calls.push({ system, userText });
      return makeNoteResponse('Until the rains return.', '— Mossling');
    };
    __setDepartureCallerForTests(mock);

    const res = await app.request(
      `/api/pets/${planting.id}/depart`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({}),
      },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: {
        planting_event: { id: string; pet_name: string };
        departure: {
          planting_event_id: string;
          goodbye_note: string;
          reason: string;
          departed_at: number;
        };
      };
    };
    expect(json.ok).toBe(true);
    expect(json.data.planting_event.id).toBe(planting.id);
    expect(json.data.departure.planting_event_id).toBe(planting.id);
    expect(json.data.departure.reason).toBe('wilted_too_long');

    const note = JSON.parse(json.data.departure.goodbye_note) as {
      note_text: string;
      signoff: string;
      fallback: boolean;
    };
    expect(note.note_text).toBe('Until the rains return.');
    expect(note.signoff).toBe('— Mossling');
    expect(note.fallback).toBe(false);
    expect(calls).toHaveLength(1);

    // DB-side post-condition: one row in pet_departures.
    const rows = await sql.unsafe<{ planting_event_id: string }[]>(
      `SELECT planting_event_id FROM pet_departures WHERE planting_event_id = $1`,
      [planting.id],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('POST /api/pets/:planting_event_id/depart — idempotency', () => {
  it('second call returns the same row without re-invoking the Anthropic caller', async () => {
    const fx = await seedAuthFixture();
    const planting = await seedPlanting({ householdId: fx.householdId });
    const app = createApp(TEST_ENV);

    let invocations = 0;
    const mock: DepartureAnthropicCaller = async () => {
      invocations += 1;
      return makeNoteResponse('Be well.', '— M');
    };
    __setDepartureCallerForTests(mock);

    const first = await app.request(
      `/api/pets/${planting.id}/depart`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({}),
      },
      TEST_ENV,
    );
    expect(first.status).toBe(200);
    const firstJson = await first.json() as {
      data: { departure: { planting_event_id: string; goodbye_note: string; departed_at: number } };
    };
    expect(invocations).toBe(1);

    const second = await app.request(
      `/api/pets/${planting.id}/depart`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({}),
      },
      TEST_ENV,
    );
    expect(second.status).toBe(200);
    const secondJson = await second.json() as {
      data: { departure: { planting_event_id: string; goodbye_note: string; departed_at: number } };
    };

    // No second Anthropic invocation.
    expect(invocations).toBe(1);

    // Byte-identical goodbye notes + matching departed_at confirms the
    // second call returned the persisted row rather than re-generating.
    expect(secondJson.data.departure.goodbye_note).toBe(firstJson.data.departure.goodbye_note);
    expect(secondJson.data.departure.departed_at).toBe(firstJson.data.departure.departed_at);
  });
});

describe('POST /api/pets/:planting_event_id/depart — failure paths', () => {
  it('returns 404 when the planting event does not exist', async () => {
    const fx = await seedAuthFixture();
    const app = createApp(TEST_ENV);

    const res = await app.request(
      `/api/pets/pe-does-not-exist/depart`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({}),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as { ok: boolean; error?: { code: string } };
    expect(json.ok).toBe(false);
    expect(json.error?.code).toBe('not_found');
  });

  it('returns 409 already_graduated when planting_events.completed_at is set', async () => {
    const fx = await seedAuthFixture();
    const planting = await seedPlanting({
      householdId: fx.householdId,
      completedAt: Date.now(),
    });
    const app = createApp(TEST_ENV);

    const res = await app.request(
      `/api/pets/${planting.id}/depart`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({}),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as { ok: boolean; error?: { code: string } };
    expect(json.ok).toBe(false);
    expect(json.error?.code).toBe('already_graduated');

    // No row was inserted.
    const rows = await sql.unsafe<{ planting_event_id: string }[]>(
      `SELECT planting_event_id FROM pet_departures WHERE planting_event_id = $1`,
      [planting.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('falls back to a deterministic goodbye note when the Anthropic caller throws', async () => {
    const fx = await seedAuthFixture();
    const planting = await seedPlanting({
      householdId: fx.householdId,
      petName: 'Yarrow',
    });
    const app = createApp(TEST_ENV);

    const mock: DepartureAnthropicCaller = async () => {
      throw new Error('Anthropic 500: internal_error');
    };
    __setDepartureCallerForTests(mock);

    const res = await app.request(
      `/api/pets/${planting.id}/depart`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fx.sessionToken}`,
        },
        body: JSON.stringify({}),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { departure: { goodbye_note: string } };
    };
    const note = JSON.parse(json.data.departure.goodbye_note) as {
      note_text: string;
      signoff: string;
      fallback: boolean;
      fallback_attempts: number;
    };
    expect(note.note_text).toBe("I'll miss you.");
    expect(note.signoff).toBe('— Yarrow');
    expect(note.fallback).toBe(true);
    expect(note.fallback_attempts).toBe(1);
  });
});

describe('POST /api/pets/:planting_event_id/depart — cross-household isolation', () => {
  it('returns 404 when the planting belongs to a different household', async () => {
    const owner = await seedAuthFixture();
    const intruder = await seedAuthFixture();
    const planting = await seedPlanting({ householdId: owner.householdId });
    const app = createApp(TEST_ENV);

    // The intruder's session has its own household. The depart route's
    // requireHousehold middleware resolves to the intruder's household,
    // so the lock-select misses (cross-household isolation) and returns
    // 404 — same as if the planting didn't exist at all.
    const res = await app.request(
      `/api/pets/${planting.id}/depart`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${intruder.sessionToken}`,
        },
        body: JSON.stringify({}),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(404);

    // Confirm no row leaked into the intruder's household either.
    const rows = await sql.unsafe<{ planting_event_id: string }[]>(
      `SELECT planting_event_id FROM pet_departures WHERE planting_event_id = $1`,
      [planting.id],
    );
    expect(rows).toHaveLength(0);
  });
});
