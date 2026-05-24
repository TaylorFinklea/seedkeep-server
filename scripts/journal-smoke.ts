/**
 * Journal smoke test — exercises the Phase 3 journal feature end-to-end
 * against a locally-running dev server (`bun run dev`) + local Postgres.
 * Not part of the automated test suite; run manually with:
 *
 *   bun run scripts/journal-smoke.ts
 *
 * Prerequisites:
 *   - `bun run dev` is running (default port 8787)
 *   - Local Postgres is running with journal migrations applied
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

// ── fixtures ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const sql = postgres(DATABASE_URL, {
    transform: { undefined: null },
    onnotice: () => { /* silence */ },
  });

  // IDs we'll clean up at the end
  const userId = `smoke-journal-user-${nanoid12()}`;
  const householdId = `smoke-journal-hh-${nanoid12()}`;
  const token = `smoke-journal-token-${nanoid12()}`;
  const sessionId = `smoke-journal-sess-${nanoid12()}`;

  // Server-assigned IDs captured during the run, used by the cleanup block.
  let entryId = '';
  let checklistItemId = '';

  console.log('\n── journal smoke test ─────────────────────────────────────────────\n');

  try {
    // ── seed fixtures ─────────────────────────────────────────────────────────
    const now = Date.now();
    const expiresAt = now + 1000 * 60 * 60 * 24; // 24 hours

    await sql.unsafe(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, FALSE, $4, $4)`,
      [userId, 'Smoke Journal User', `smoke-journal-${nanoid12()}@test.invalid`, now],
    );
    await sql.unsafe(
      `INSERT INTO session (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [sessionId, expiresAt, token, now, userId],
    );
    await sql.unsafe(
      `INSERT INTO households (id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)`,
      [householdId, 'Smoke Journal Household', now],
    );
    await sql.unsafe(
      `INSERT INTO memberships (household_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)`,
      [householdId, userId, now],
    );

    // ── check 1: empty feed ───────────────────────────────────────────────────
    {
      const { status, body } = await api('GET', '/journal', { token });
      const b = body as { ok: boolean; data?: { items?: unknown[] } };
      check(
        'Check 1: GET /journal on fresh household → 200, items empty',
        status === 200 && b.ok === true && Array.isArray(b.data?.items) && b.data!.items!.length === 0,
        `status=${status} items.length=${b.data?.items?.length}`,
      );
    }

    // ── check 2: create entry ─────────────────────────────────────────────────
    {
      const { status, body } = await api('POST', '/journal', {
        token,
        body: { occurred_on: '2026-05-24', body: 'Planted Ozark Giant peppers.' },
      });
      const b = body as { ok: boolean; data?: { entry?: { id?: string; body?: string } } };
      const ok = status === 200
        && b.ok === true
        && typeof b.data?.entry?.id === 'string'
        && b.data?.entry?.body === 'Planted Ozark Giant peppers.';
      if (ok) entryId = b.data!.entry!.id!;
      check(
        'Check 2: POST /journal → 200, body matches input',
        ok,
        `status=${status} entry.body=${b.data?.entry?.body}`,
      );
    }

    // ── check 3: feed lists the new entry ─────────────────────────────────────
    {
      const { status, body } = await api('GET', '/journal?since=0', { token });
      const b = body as { ok: boolean; data?: { items?: Array<{ id?: string }> } };
      check(
        'Check 3: GET /journal?since=0 → items contains created entry',
        status === 200
          && Array.isArray(b.data?.items)
          && b.data!.items!.length === 1
          && b.data!.items![0].id === entryId,
        `status=${status} items.length=${b.data?.items?.length} id=${b.data?.items?.[0]?.id}`,
      );
    }

    // ── check 4: PATCH updates body ───────────────────────────────────────────
    {
      const { status, body } = await api('PATCH', `/journal/${entryId}`, {
        token,
        body: { body: 'Planted Ozark Giant peppers in Bed A.' },
      });
      const b = body as { ok: boolean; data?: { entry?: { body?: string } } };
      check(
        'Check 4: PATCH /journal/:id → 200, body contains "Bed A"',
        status === 200 && b.ok === true && (b.data?.entry?.body ?? '').includes('Bed A'),
        `status=${status} entry.body=${b.data?.entry?.body}`,
      );
    }

    // ── check 5: two-attach rejection ─────────────────────────────────────────
    {
      const { status, body } = await api('POST', '/journal', {
        token,
        body: {
          occurred_on: '2026-05-24',
          body: 'invalid two-attach',
          seed_id: 'fake-seed',
          bed_id: 'fake-bed',
        },
      });
      const b = body as { ok: boolean; error?: { code?: string } };
      check(
        'Check 5: POST /journal with two parent FKs → 400 bad_request',
        status === 400 && b.error?.code === 'bad_request',
        `status=${status} code=${b.error?.code}`,
      );
    }

    // ── check 6: bad occurred_on format ───────────────────────────────────────
    {
      const { status, body } = await api('POST', '/journal', {
        token,
        body: { occurred_on: 'invalid', body: 'bad date' },
      });
      const b = body as { ok: boolean; error?: { code?: string } };
      check(
        'Check 6: POST /journal with bad occurred_on → 400',
        status === 400 && b.error?.code === 'bad_request',
        `status=${status} code=${b.error?.code}`,
      );
    }

    // ── check 7: add checklist item ───────────────────────────────────────────
    {
      const { status, body } = await api('POST', `/journal/${entryId}/checklist`, {
        token,
        body: { text: 'Water seedlings' },
      });
      const b = body as { ok: boolean; data?: { item?: { id?: string; text?: string } } };
      const ok = status === 200
        && b.ok === true
        && typeof b.data?.item?.id === 'string'
        && b.data?.item?.text === 'Water seedlings';
      if (ok) checklistItemId = b.data!.item!.id!;
      check(
        'Check 7: POST /journal/:id/checklist → 200, item created with text',
        ok,
        `status=${status} item.text=${b.data?.item?.text}`,
      );
    }

    // ── check 8: toggle complete ──────────────────────────────────────────────
    {
      const { status, body } = await api('PATCH', `/journal/checklist/${checklistItemId}`, {
        token,
        body: { completed: true },
      });
      const b = body as { ok: boolean; data?: { item?: { completed?: boolean } } };
      check(
        'Check 8: PATCH /journal/checklist/:itemId → 200, completed=true',
        status === 200 && b.ok === true && b.data?.item?.completed === true,
        `status=${status} completed=${b.data?.item?.completed}`,
      );
    }

    // ── check 9: retrospective on first-year gardener → empty ────────────────
    // The only entry is on 2026-05-24 (the current year). The retrospective
    // surfaces *prior* years for this MM-DD, so a first-year gardener with
    // no history should see an empty years array — the iOS card hides itself.
    {
      const { status, body } = await api('GET', '/journal/retrospective?on=05-24', { token });
      const b = body as { ok: boolean; data?: { years?: unknown[] } };
      check(
        'Check 9: GET /journal/retrospective?on=05-24 → 200, years empty (first-year gardener)',
        status === 200 && b.ok === true && Array.isArray(b.data?.years) && b.data!.years!.length === 0,
        `status=${status} years.length=${b.data?.years?.length}`,
      );
    }

    // ── check 10: retrospective bad anchor ────────────────────────────────────
    {
      const { status, body } = await api('GET', '/journal/retrospective?on=13-99', { token });
      const b = body as { ok: boolean; error?: { code?: string } };
      check(
        'Check 10: GET /journal/retrospective?on=13-99 → 400',
        status === 400 && b.error?.code === 'bad_request',
        `status=${status} code=${b.error?.code}`,
      );
    }

    // ── check 11: soft-delete + hidden from feed ──────────────────────────────
    {
      const del = await api('DELETE', `/journal/${entryId}`, { token });
      const feed = await api('GET', '/journal?since=0', { token });
      const f = feed.body as { ok: boolean; data?: { items?: unknown[] } };
      check(
        'Check 11: DELETE /journal/:id then feed since=0 → items empty',
        del.status === 200
          && feed.status === 200
          && Array.isArray(f.data?.items)
          && f.data!.items!.length === 0,
        `del.status=${del.status} feed.status=${feed.status} items.length=${f.data?.items?.length}`,
      );
    }

  } finally {
    // ── cleanup ───────────────────────────────────────────────────────────────
    console.log('\n── cleanup ─────────────────────────────────────────────────────────\n');

    if (checklistItemId) {
      await sql.unsafe(`DELETE FROM journal_checklist_items WHERE id = $1`, [checklistItemId]);
    }
    if (entryId) {
      await sql.unsafe(`DELETE FROM journal_entry_photos WHERE entry_id = $1`, [entryId]);
      // Also catch any other checklist items tied to the entry (defensive).
      await sql.unsafe(`DELETE FROM journal_checklist_items WHERE entry_id = $1`, [entryId]);
      await sql.unsafe(`DELETE FROM journal_entries WHERE id = $1`, [entryId]);
    }

    // Delete session, household (CASCADE removes memberships), user.
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
