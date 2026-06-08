/**
 * Watering-state smoke test — exercises the Phase 4C watering-ledger feature
 * end-to-end against a locally-running dev server (`bun run dev`) + local
 * Postgres. Not part of the automated test suite; run manually with:
 *
 *   bun run scripts/watering-state-smoke.ts
 *
 * Prerequisites:
 *   - `bun run dev` is running (default port 8787)
 *   - Local Postgres is running with migration 0019 applied
 *
 * Covers: GET returns null on a fresh household, POST sets the timestamp,
 * GET round-trips it, POST with an earlier timestamp returns the existing
 * value (GREATEST semantics), POST with a later timestamp updates.
 */

import postgres from 'postgres';

const BASE_URL = 'http://localhost:8787/api';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://seedkeep:dev-only@localhost:5432/seedkeep';

// ── helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    console.error(`\nCould not reach ${BASE_URL}${path}.`);
    console.error('Please start the dev server first:  bun run dev\n');
    throw err;
  }
  const body = await res.json();
  return { status: res.status, body };
}

function nanoid12(): string {
  return Math.random().toString(36).slice(2, 14).padEnd(12, '0');
}

// Two well-defined ISO8601 timestamps used across the round-trip checks.
// `tEarly` is intentionally earlier than `tLate` so the GREATEST semantics
// are visible at the API boundary.
const tEarly = '2026-06-01T08:00:00.000Z';
const tMid   = '2026-06-04T08:00:00.000Z';
const tLate  = '2026-06-07T08:00:00.000Z';

// ── fixtures ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const sql = postgres(DATABASE_URL, {
    transform: { undefined: null },
    onnotice: () => { /* silence */ },
  });

  const userId = `smoke-water-user-${nanoid12()}`;
  const householdId = `smoke-water-hh-${nanoid12()}`;
  const token = `smoke-water-token-${nanoid12()}`;
  const sessionId = `smoke-water-sess-${nanoid12()}`;

  console.log('\n── watering-state smoke test ──────────────────────────────────────\n');

  try {
    // ── seed fixtures ─────────────────────────────────────────────────────────
    const now = Date.now();
    const expiresAt = now + 1000 * 60 * 60 * 24;

    await sql.unsafe(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, FALSE, $4, $4)`,
      [userId, 'Smoke Water User', `smoke-water-${nanoid12()}@test.invalid`, now],
    );
    await sql.unsafe(
      `INSERT INTO session (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [sessionId, expiresAt, token, now, userId],
    );
    await sql.unsafe(
      `INSERT INTO households (id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)`,
      [householdId, 'Smoke Water Household', now],
    );
    await sql.unsafe(
      `INSERT INTO memberships (household_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)`,
      [householdId, userId, now],
    );

    // ── check 1: GET on fresh household → null ────────────────────────────────
    {
      const { status, body } = await api('GET', `/households/${householdId}/watering-state`, { token });
      const b = body as { ok: boolean; data?: { last_watering_notification_at?: string | null } };
      check(
        'Check 1: GET fresh household → 200, last_watering_notification_at null',
        status === 200 && b.ok === true && b.data?.last_watering_notification_at === null,
        `status=${status} value=${b.data?.last_watering_notification_at}`,
      );
    }

    // ── check 2: POST sets the timestamp ─────────────────────────────────────
    {
      const { status, body } = await api('POST', `/households/${householdId}/watering-state`, {
        token,
        body: { scheduled_for: tMid },
      });
      const b = body as { ok: boolean; data?: { last_watering_notification_at?: string | null } };
      const got = b.data?.last_watering_notification_at;
      check(
        'Check 2: POST scheduled_for=tMid → 200, returns tMid',
        status === 200 && b.ok === true && typeof got === 'string' && new Date(got).getTime() === Date.parse(tMid),
        `status=${status} value=${got}`,
      );
    }

    // ── check 3: GET returns the persisted timestamp ─────────────────────────
    {
      const { status, body } = await api('GET', `/households/${householdId}/watering-state`, { token });
      const b = body as { ok: boolean; data?: { last_watering_notification_at?: string | null } };
      const got = b.data?.last_watering_notification_at;
      check(
        'Check 3: GET after POST → returns the stored tMid timestamp',
        status === 200 && typeof got === 'string' && new Date(got).getTime() === Date.parse(tMid),
        `status=${status} value=${got}`,
      );
    }

    // ── check 4: POST with earlier timestamp keeps the existing value ─────────
    {
      const { status, body } = await api('POST', `/households/${householdId}/watering-state`, {
        token,
        body: { scheduled_for: tEarly },
      });
      const b = body as { ok: boolean; data?: { last_watering_notification_at?: string | null } };
      const got = b.data?.last_watering_notification_at;
      check(
        'Check 4: POST earlier timestamp → returns existing tMid (GREATEST semantics)',
        status === 200 && typeof got === 'string' && new Date(got).getTime() === Date.parse(tMid),
        `status=${status} value=${got}`,
      );
    }

    // ── check 5: POST with later timestamp advances ──────────────────────────
    {
      const { status, body } = await api('POST', `/households/${householdId}/watering-state`, {
        token,
        body: { scheduled_for: tLate },
      });
      const b = body as { ok: boolean; data?: { last_watering_notification_at?: string | null } };
      const got = b.data?.last_watering_notification_at;
      check(
        'Check 5: POST later timestamp → returns tLate',
        status === 200 && typeof got === 'string' && new Date(got).getTime() === Date.parse(tLate),
        `status=${status} value=${got}`,
      );
    }

    // ── check 6: bad body shape rejected ──────────────────────────────────────
    {
      const { status, body } = await api('POST', `/households/${householdId}/watering-state`, {
        token,
        body: { scheduled_for: 'not-a-date' },
      });
      const b = body as { ok: boolean; error?: { code?: string } };
      check(
        'Check 6: POST with non-ISO8601 body → 400 bad_request',
        status === 400 && b.error?.code === 'bad_request',
        `status=${status} code=${b.error?.code}`,
      );
    }

    // ── check 7: cross-household isolation ────────────────────────────────────
    {
      const otherHouseholdId = `smoke-water-hh-other-${nanoid12()}`;
      const { status } = await api('GET', `/households/${otherHouseholdId}/watering-state`, { token });
      check(
        'Check 7: GET another household id with this session → 404',
        status === 404,
        `status=${status}`,
      );
    }
  } finally {
    // ── cleanup ───────────────────────────────────────────────────────────────
    console.log('\n── cleanup ─────────────────────────────────────────────────────────\n');

    await sql.unsafe(`DELETE FROM session WHERE id = $1`, [sessionId]);
    await sql.unsafe(`DELETE FROM households WHERE id = $1`, [householdId]);
    await sql.unsafe(`DELETE FROM "user" WHERE id = $1`, [userId]);

    console.log('  Deleted smoke test fixtures');

    await sql.end();
  }

  // ── summary ───────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n── ${passed}/${total} smoke checks passed ──────────────────────────────\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
