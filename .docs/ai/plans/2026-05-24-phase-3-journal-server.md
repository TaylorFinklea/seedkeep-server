# Phase 3 — Journal — Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the server side of the Phase 3 journal — `journal_entries` + `journal_entry_photos` + `journal_checklist_items` tables, 10 new routes, retrospective query, sync envelope extension, and a migration that converts legacy `planting_events.kind='note'` rows into journal entries.

**Architecture:** Three new tables that follow Seedkeep's established household_id-leading + soft-delete + updated_at sync conventions. Journal entries have at-most-one polymorphic attach (seed/bed/planting_event) enforced by a CHECK constraint with real FK integrity. Retrospective is a query-on-demand route (no aggregation table) using a `to_char(occurred_on, 'MM-DD')` predicate with ±3-day fuzz. Photos reuse the same S3 bucket and upload shape as `seed_photos`. Checklist items are a separate table for per-item sync granularity.

**Tech Stack:** Bun, Hono, Postgres (`postgres.js`), Vitest. No new runtime dependencies.

**Spec:** `~/git/seedkeep/.docs/ai/specs/2026-05-24-phase-3-journal-design.md`.

**Conventions** (verified against the codebase — follow exactly):
- IDs: `TEXT PRIMARY KEY`, generated with `nanoid` in app code.
- Domain timestamps: `BIGINT` ms-epoch (`Date.now()`).
- Calendar dates: `DATE` for actual dates (e.g. `occurred_on`), `TEXT` `'YYYY-MM-DD'` for app-facing wire format.
- Enums: `CHECK` constraints, not Postgres `ENUM`.
- DB access: `dbGet`/`dbAll`/`dbRun`/`dbBatch` from `src/db/helpers.ts`, `$1`-style params.
- Routes: per-route middleware composition — `const auth = [requireAuth(), requireHousehold()] as const;` then `routes.get('/path', ...auth, handler)`. Never `use('*')`.
- Success: `c.json({ ok: true, data: {...} })`. Error: `c.json({ ok: false, error: { code, message } }, status)`.
- Tests: pure-function Vitest only, under `src/**/__tests__/`. Run with `bun run test`. Integration tests live in `scripts/*-smoke.ts`.
- Photo uploads: existing `seed_photos` upload path is the reference — multipart, S3-keyed, host `seedkeep-server.fly.dev` proxies to MinIO/S3 via `src/lib/storage/`.
- Migrations: append-only, applied via `bun run migrate` (idempotent), auto-applied on Fly deploy via `release_command` in `fly.toml`. **A migration that adds a column AND requires its value for downstream behavior MUST backfill** — see `~/.claude/projects/-Users-tfinklea-git-seedkeep/memory/migration-backfill-required.md`.

**Plan-level decisions (refinements of the spec):**
- **Retrospective fuzz uses `to_char(occurred_on, 'MM-DD')` predicate**, not a separate `occurred_mm_dd` generated column. Index on `(household_id, to_char(occurred_on, 'MM-DD'))` if perf needs it later — at hundreds-of-entries scale it doesn't.
- **Soft delete is `deleted_at BIGINT` on journal_entries** (matches seeds/beds/events). **Hard delete on `journal_entry_photos` and `journal_checklist_items`** when the parent entry is deleted (via CASCADE) — these are owned strictly by the parent, no sync-conflict surface area worth preserving them through.
- **`PATCH /api/journal/:id` accepts a full subset** of `{body, occurred_on, seed_id, bed_id, planting_event_id}` — switching the attached entity is a single request, not "delete + recreate."

---

## File Structure

**Create:**
- `migrations/0011_journal.sql` — three tables, indexes, data migration from `planting_events.kind='note'`.
- `src/lib/journal/retrospective.ts` — pure helper for the ±3-day MM-DD predicate.
- `src/lib/journal/__tests__/retrospective.test.ts`.
- `src/lib/journal/validation.ts` — pure helper: validate the at-most-one-FK constraint client-side before the SQL CHECK catches it (gives a better error message).
- `src/lib/journal/__tests__/validation.test.ts`.
- `src/routes/journal.ts` — 10 new routes.
- `scripts/journal-smoke.ts` — end-to-end smoke checks.

**Modify:**
- `src/index.ts` — mount `journalRoutes` at `/api/journal`.
- `src/routes/sync.ts` — extend the delta-sync envelope with `journal_entries`, `journal_entry_photos`, `journal_checklist_items` cursors. *(If the codebase doesn't have `src/routes/sync.ts` exactly, find the file that owns the existing `GET /api/sync` route — likely `src/routes/sync.ts` or inlined in `src/index.ts` — and extend it there.)*
- `package.json` — no new scripts; smoke script run via `bun run scripts/journal-smoke.ts`.

---

## Task 1: Migration 0011 — schema + data migration

**Files:**
- Create: `migrations/0011_journal.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/0011_journal.sql` with exactly this content:

```sql
-- Migration: Phase 3 (journal) foundation.
--
-- Adds three tables for the unified journal model:
--   journal_entries          — one entry per gardener-day, optional polymorphic
--                              attach to seed / bed / planting_event (CHECK
--                              enforces at-most-one).
--   journal_entry_photos     — photos attached to a journal entry; same S3
--                              bucket as seed_photos but a separate table
--                              so journal concerns don't bleed into seed_photos.
--   journal_checklist_items  — flat checklist items per entry; separate table
--                              for per-item sync granularity.
--
-- Also migrates existing planting_events.kind='note' rows into
-- journal_entries (the proto-journal that has sat unused since migration
-- 0005) and drops 'note' from the planting_events.kind CHECK constraint.
-- This is the one migration that BOTH adds schema AND backfills existing
-- data in the same transaction — required by the migration-backfill rule
-- (see decisions.md + the migration-backfill-required memory).

CREATE TABLE IF NOT EXISTS journal_entries (
  id                 TEXT PRIMARY KEY,
  household_id       TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  occurred_on        DATE NOT NULL,
  body               TEXT NOT NULL DEFAULT '',
  seed_id            TEXT REFERENCES seeds(id) ON DELETE CASCADE,
  bed_id             TEXT REFERENCES beds(id) ON DELETE CASCADE,
  planting_event_id  TEXT REFERENCES planting_events(id) ON DELETE CASCADE,
  CHECK ((seed_id IS NOT NULL)::int + (bed_id IS NOT NULL)::int +
         (planting_event_id IS NOT NULL)::int <= 1),
  created_at         BIGINT NOT NULL,
  updated_at         BIGINT NOT NULL,
  deleted_at         BIGINT
);

CREATE INDEX IF NOT EXISTS idx_journal_entries_household_occurred
  ON journal_entries(household_id, occurred_on DESC);
CREATE INDEX IF NOT EXISTS idx_journal_entries_household_updated
  ON journal_entries(household_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_journal_entries_seed
  ON journal_entries(seed_id) WHERE seed_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_bed
  ON journal_entries(bed_id) WHERE bed_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_event
  ON journal_entries(planting_event_id) WHERE planting_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS journal_entry_photos (
  id            TEXT PRIMARY KEY,
  entry_id      TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  storage_key   TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  width         INTEGER,
  height        INTEGER,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_photos_entry
  ON journal_entry_photos(entry_id, sort_order);

CREATE TABLE IF NOT EXISTS journal_checklist_items (
  id          TEXT PRIMARY KEY,
  entry_id    TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  completed   BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  updated_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checklist_items_entry
  ON journal_checklist_items(entry_id, sort_order);

-- Convert existing free-form note events into journal entries.
-- Reuses the event ID as the journal entry ID — cheap defensive: any local
-- code still pointing at the old ID reconciles cleanly without a lookup table.
INSERT INTO journal_entries (id, household_id, occurred_on, body, bed_id,
                             created_at, updated_at)
SELECT id, household_id, planned_for, COALESCE(notes, ''), bed_id,
       created_at, updated_at
  FROM planting_events
 WHERE kind = 'note' AND deleted_at IS NULL
ON CONFLICT (id) DO NOTHING;

-- Soft-delete the migrated planting_events rows so two-device merges see
-- "removed" not "vanished." Hard-deleting would lose the sync watermark.
UPDATE planting_events
   SET deleted_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
       updated_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
 WHERE kind = 'note' AND deleted_at IS NULL;

-- Rebuild the kind CHECK without 'note'. Same DROP+ADD pattern migration
-- 0009 used for recommendation_cache.source.
ALTER TABLE planting_events DROP CONSTRAINT IF EXISTS planting_events_kind_check;
ALTER TABLE planting_events ADD CONSTRAINT planting_events_kind_check
  CHECK (kind IN ('sowing', 'transplant', 'harvest'));
```

- [ ] **Step 2: Apply locally**

Run: `bun run migrate`
Expected: `→ applying 0011_journal.sql… ok` and `Applied 1 migration(s).`

- [ ] **Step 3: Verify schema in Postgres**

Run: `docker exec seedkeep-db psql -U seedkeep -d seedkeep -c "\d journal_entries"`
Expected: three indexes listed, CHECK constraint visible, FKs to households/seeds/beds/planting_events.

- [ ] **Step 4: Commit**

```bash
git add migrations/0011_journal.sql
git commit -m "Add migration 0011: journal_entries + photos + checklist items"
```

---

## Task 2: Pure libs — retrospective fuzz + at-most-one validation

**Files:**
- Create: `src/lib/journal/retrospective.ts`
- Create: `src/lib/journal/__tests__/retrospective.test.ts`
- Create: `src/lib/journal/validation.ts`
- Create: `src/lib/journal/__tests__/validation.test.ts`

- [ ] **Step 1: Write the retrospective helper**

Create `src/lib/journal/retrospective.ts`:

```typescript
// Pure helpers for the year-over-year retrospective.
//
// Retrospective semantics: given an anchor MM-DD, return entries whose
// occurred_on MM-DD falls within ±3 days of the anchor. The ±3 fuzz is
// because gardeners don't journal every single day — May 24 should also
// surface a May 22 entry from a prior year if that was the closest.

const MMDD = /^\d{2}-\d{2}$/;

export function validateMmDd(anchor: string): boolean {
  if (!MMDD.test(anchor)) return false;
  const [m, d] = anchor.split('-').map((s) => parseInt(s, 10));
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  return true;
}

/**
 * Build the predicate fragment + params for a retrospective query.
 * Returns the list of MM-DD strings that fall within ±3 days of `anchor`
 * (handles month/year wrap correctly so Dec 31 ± 3 includes Jan 2-3).
 */
export function retrospectiveMmDdWindow(anchor: string): string[] {
  if (!validateMmDd(anchor)) throw new Error(`invalid MM-DD anchor: ${anchor}`);
  const [m, d] = anchor.split('-').map((s) => parseInt(s, 10));
  // Use a non-leap year as the reference so Feb 29 isn't accidentally generated.
  const base = new Date(Date.UTC(2023, m - 1, d));
  const days: string[] = [];
  for (let off = -3; off <= 3; off++) {
    const dt = new Date(base.getTime() + off * 86_400_000);
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    days.push(`${mm}-${dd}`);
  }
  return days;
}
```

- [ ] **Step 2: Write retrospective tests**

Create `src/lib/journal/__tests__/retrospective.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateMmDd, retrospectiveMmDdWindow } from '../retrospective';

describe('validateMmDd', () => {
  it('accepts valid MM-DD', () => {
    expect(validateMmDd('05-24')).toBe(true);
    expect(validateMmDd('12-31')).toBe(true);
    expect(validateMmDd('01-01')).toBe(true);
  });
  it('rejects malformed input', () => {
    expect(validateMmDd('5-24')).toBe(false);
    expect(validateMmDd('05-32')).toBe(false);
    expect(validateMmDd('13-01')).toBe(false);
    expect(validateMmDd('')).toBe(false);
    expect(validateMmDd('2024-05-24')).toBe(false);
  });
});

describe('retrospectiveMmDdWindow', () => {
  it('returns 7 days centered on the anchor', () => {
    const days = retrospectiveMmDdWindow('05-24');
    expect(days).toEqual(['05-21', '05-22', '05-23', '05-24', '05-25', '05-26', '05-27']);
  });
  it('wraps around year boundary at end', () => {
    const days = retrospectiveMmDdWindow('12-31');
    expect(days.slice(0, 4)).toEqual(['12-28', '12-29', '12-30', '12-31']);
    expect(days.slice(4)).toEqual(['01-01', '01-02', '01-03']);
  });
  it('wraps around year boundary at start', () => {
    const days = retrospectiveMmDdWindow('01-01');
    expect(days.slice(0, 3)).toEqual(['12-29', '12-30', '12-31']);
    expect(days.slice(3)).toEqual(['01-01', '01-02', '01-03', '01-04']);
  });
  it('rejects invalid anchor', () => {
    expect(() => retrospectiveMmDdWindow('13-01')).toThrow('invalid MM-DD');
  });
});
```

- [ ] **Step 3: Write the validation helper**

Create `src/lib/journal/validation.ts`:

```typescript
// Pure validation: journal entries may attach to at most one of seed / bed /
// planting_event. The SQL CHECK catches violations at INSERT time, but doing
// it client-side first gives the route a clean { ok: false, code: 'bad_request',
// message: '...' } response instead of a 500 from a constraint violation.

export interface AttachInput {
  seed_id?: string | null;
  bed_id?: string | null;
  planting_event_id?: string | null;
}

export function validateAtMostOneAttach(input: AttachInput):
  | { ok: true }
  | { ok: false; reason: string } {
  const set = [input.seed_id, input.bed_id, input.planting_event_id]
    .filter((v) => v != null && v !== '').length;
  if (set <= 1) return { ok: true };
  return {
    ok: false,
    reason: 'journal entry may attach to at most one of seed, bed, or planting event',
  };
}
```

- [ ] **Step 4: Write validation tests**

Create `src/lib/journal/__tests__/validation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateAtMostOneAttach } from '../validation';

describe('validateAtMostOneAttach', () => {
  it('accepts no attachment', () => {
    expect(validateAtMostOneAttach({}).ok).toBe(true);
    expect(validateAtMostOneAttach({ seed_id: null, bed_id: null, planting_event_id: null }).ok).toBe(true);
  });
  it('accepts exactly one attachment', () => {
    expect(validateAtMostOneAttach({ seed_id: 's1' }).ok).toBe(true);
    expect(validateAtMostOneAttach({ bed_id: 'b1' }).ok).toBe(true);
    expect(validateAtMostOneAttach({ planting_event_id: 'e1' }).ok).toBe(true);
  });
  it('rejects two attachments', () => {
    const r = validateAtMostOneAttach({ seed_id: 's1', bed_id: 'b1' });
    expect(r.ok).toBe(false);
  });
  it('rejects three attachments', () => {
    const r = validateAtMostOneAttach({ seed_id: 's1', bed_id: 'b1', planting_event_id: 'e1' });
    expect(r.ok).toBe(false);
  });
  it('treats empty string as unset', () => {
    expect(validateAtMostOneAttach({ seed_id: '', bed_id: 'b1' }).ok).toBe(true);
  });
});
```

- [ ] **Step 5: Run tests**

Run: `bun run test src/lib/journal`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/journal/
git commit -m "Add journal pure libs: retrospective MM-DD fuzz + at-most-one validation"
```

---

## Task 3: Journal CRUD routes — feed + create + update + delete

**Files:**
- Create: `src/routes/journal.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Scaffold the route file**

Create `src/routes/journal.ts`. This task implements the entry CRUD; photos/checklist/retrospective routes land in later tasks. Use exactly this scaffolding (it follows the per-route auth composition + envelope shape from `src/routes/recommendations.ts`):

```typescript
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { getSql } from '../db/client';
import { dbGet, dbAll, dbRun } from '../db/helpers';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { validateAtMostOneAttach } from '../lib/journal/validation';
import { retrospectiveMmDdWindow, validateMmDd } from '../lib/journal/retrospective';

const auth = [requireAuth(), requireHousehold()] as const;

interface EntryRow {
  id: string;
  household_id: string;
  occurred_on: string;             // 'YYYY-MM-DD' from Postgres DATE
  body: string;
  seed_id: string | null;
  bed_id: string | null;
  planting_event_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

function rowToDto(r: EntryRow) {
  return {
    id: r.id,
    householdId: r.household_id,
    occurredOn: r.occurred_on,
    body: r.body,
    seedId: r.seed_id,
    bedId: r.bed_id,
    plantingEventId: r.planting_event_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

export const journalRoutes = new Hono<AppEnv>();

// GET /api/journal — paginated chronological feed
journalRoutes.get('/', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const seedId = c.req.query('seed_id');
  const bedId = c.req.query('bed_id');
  const eventId = c.req.query('planting_event_id');
  const fromDate = c.req.query('from_date');
  const toDate = c.req.query('to_date');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 200);

  // Build a parameterized WHERE. dbAll uses $1-style params.
  const conditions: string[] = ['household_id = $1', 'deleted_at IS NULL'];
  const params: unknown[] = [householdId];
  let p = 2;

  if (seedId) { conditions.push(`seed_id = $${p++}`); params.push(seedId); }
  if (bedId) { conditions.push(`bed_id = $${p++}`); params.push(bedId); }
  if (eventId) { conditions.push(`planting_event_id = $${p++}`); params.push(eventId); }
  if (fromDate) { conditions.push(`occurred_on >= $${p++}`); params.push(fromDate); }
  if (toDate) { conditions.push(`occurred_on <= $${p++}`); params.push(toDate); }

  params.push(limit);
  const rows = await dbAll<EntryRow>(
    sql,
    `SELECT id, household_id, occurred_on::text, body, seed_id, bed_id,
            planting_event_id, created_at, updated_at, deleted_at
       FROM journal_entries
      WHERE ${conditions.join(' AND ')}
      ORDER BY occurred_on DESC, id DESC
      LIMIT $${p}`,
    params,
  );

  return c.json({ ok: true, data: { entries: rows.map(rowToDto) } });
});

// POST /api/journal — create an entry
journalRoutes.post('/', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'JSON body required' } }, 400);
  }
  const v = validateAtMostOneAttach(body);
  if (!v.ok) {
    return c.json({ ok: false, error: { code: 'bad_request', message: v.reason } }, 400);
  }
  const occurredOn = typeof body.occurred_on === 'string' ? body.occurred_on : null;
  if (!occurredOn || !/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'occurred_on must be YYYY-MM-DD' } }, 400);
  }

  const id = nanoid();
  const now = Date.now();
  await dbRun(
    sql,
    `INSERT INTO journal_entries
       (id, household_id, occurred_on, body, seed_id, bed_id, planting_event_id,
        created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
    [
      id, householdId, occurredOn, body.body ?? '',
      body.seed_id ?? null, body.bed_id ?? null, body.planting_event_id ?? null,
      now,
    ],
  );

  const row = await dbGet<EntryRow>(
    sql,
    `SELECT id, household_id, occurred_on::text, body, seed_id, bed_id,
            planting_event_id, created_at, updated_at, deleted_at
       FROM journal_entries WHERE id = $1`,
    [id],
  );
  return c.json({ ok: true, data: { entry: rowToDto(row!) } });
});

// PATCH /api/journal/:id — update body / occurred_on / parent ref
journalRoutes.patch('/:id', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'JSON body required' } }, 400);
  }
  // If any parent ref is in the patch, validate the at-most-one rule on the
  // patched view of the row. We don't fetch + merge here because the SQL
  // CHECK will still catch any contradiction; the early validation just
  // produces a nicer error when the client sends two non-null refs at once.
  const v = validateAtMostOneAttach({
    seed_id: body.seed_id, bed_id: body.bed_id, planting_event_id: body.planting_event_id,
  });
  if (!v.ok) {
    return c.json({ ok: false, error: { code: 'bad_request', message: v.reason } }, 400);
  }

  // Build a SET clause only for fields actually in the request.
  const sets: string[] = ['updated_at = $1'];
  const params: unknown[] = [Date.now()];
  let p = 2;

  if ('body' in body) { sets.push(`body = $${p++}`); params.push(body.body ?? ''); }
  if ('occurred_on' in body) { sets.push(`occurred_on = $${p++}`); params.push(body.occurred_on); }
  if ('seed_id' in body) { sets.push(`seed_id = $${p++}`); params.push(body.seed_id ?? null); }
  if ('bed_id' in body) { sets.push(`bed_id = $${p++}`); params.push(body.bed_id ?? null); }
  if ('planting_event_id' in body) { sets.push(`planting_event_id = $${p++}`); params.push(body.planting_event_id ?? null); }

  params.push(id, householdId);
  await dbRun(
    sql,
    `UPDATE journal_entries SET ${sets.join(', ')}
       WHERE id = $${p++} AND household_id = $${p} AND deleted_at IS NULL`,
    params,
  );

  const row = await dbGet<EntryRow>(
    sql,
    `SELECT id, household_id, occurred_on::text, body, seed_id, bed_id,
            planting_event_id, created_at, updated_at, deleted_at
       FROM journal_entries WHERE id = $1 AND household_id = $2`,
    [id, householdId],
  );
  if (!row) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'entry not found' } }, 404);
  }
  return c.json({ ok: true, data: { entry: rowToDto(row) } });
});

// DELETE /api/journal/:id — soft-delete
journalRoutes.delete('/:id', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const id = c.req.param('id');
  const now = Date.now();
  await dbRun(
    sql,
    `UPDATE journal_entries SET deleted_at = $1, updated_at = $1
       WHERE id = $2 AND household_id = $3 AND deleted_at IS NULL`,
    [now, id, householdId],
  );
  return c.json({ ok: true, data: { id } });
});
```

- [ ] **Step 2: Mount the routes**

Modify `src/index.ts`. Find the existing route mounts (e.g. `app.route('/api/recommendations', recommendationRoutes)`) and add alongside them:

```typescript
import { journalRoutes } from './routes/journal';
// ...
app.route('/api/journal', journalRoutes);
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: clean exit.

- [ ] **Step 4: Manual route check via curl**

Run: `curl -i http://localhost:8787/api/journal`
Expected: 401 unauthenticated. (Auth-gated routes return 401 for unauthorized requests — same pattern as the recommendations route.)

- [ ] **Step 5: Commit**

```bash
git add src/routes/journal.ts src/index.ts
git commit -m "Add journal entry CRUD routes (feed, create, update, soft-delete)"
```

---

## Task 4: Photo routes — upload + delete

**Files:**
- Modify: `src/routes/journal.ts`

- [ ] **Step 1: Find the photo upload pattern**

Read `src/routes/seeds.ts` (or wherever the existing `seed_photos` upload route lives — `grep -l "seed_photos" src/routes/` to find it) and identify the multipart parser + S3 upload helper. The journal photo upload follows the same pattern, with `entry_id` replacing `seed_id`. Expected helpers: `parseMultipart()`, `uploadToStorage(key, bytes)` or similar — confirm the actual names by reading the file.

- [ ] **Step 2: Add photo routes to `src/routes/journal.ts`**

Append to the existing `journal.ts`:

```typescript
import { uploadPhotoToStorage, deletePhotoFromStorage } from '../lib/storage';
// (Confirm the actual storage helper module path/name during Step 1 above.
// If the helpers live elsewhere — e.g. inlined in src/routes/seeds.ts —
// extract them into src/lib/storage/ first, then import here. That keeps
// journal.ts from re-implementing upload mechanics.)

interface PhotoRow {
  id: string;
  entry_id: string;
  household_id: string;
  storage_key: string;
  sort_order: number;
  width: number | null;
  height: number | null;
  created_at: number;
}

function photoToDto(p: PhotoRow) {
  return {
    id: p.id,
    entryId: p.entry_id,
    storageKey: p.storage_key,
    sortOrder: p.sort_order,
    width: p.width,
    height: p.height,
    createdAt: p.created_at,
  };
}

// POST /api/journal/:id/photos — upload a photo to a journal entry
journalRoutes.post('/:id/photos', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const entryId = c.req.param('id');

  // Verify the entry exists and belongs to this household.
  const owner = await dbGet<{ id: string }>(
    sql,
    `SELECT id FROM journal_entries
      WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`,
    [entryId, householdId],
  );
  if (!owner) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'entry not found' } }, 404);
  }

  // Reuse the multipart parser used by the seed-photo upload route.
  const formData = await c.req.formData();
  const file = formData.get('photo');
  if (!(file instanceof File)) {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'multipart field "photo" required' } }, 400);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());

  const id = nanoid();
  const storageKey = `journal/${householdId}/${entryId}/${id}.jpg`;
  await uploadPhotoToStorage(c.env, storageKey, bytes, file.type || 'image/jpeg');

  // sort_order = max(existing) + 1 so new photos append.
  const maxRow = await dbGet<{ max: number | null }>(
    sql,
    `SELECT MAX(sort_order) AS max FROM journal_entry_photos WHERE entry_id = $1`,
    [entryId],
  );
  const sortOrder = (maxRow?.max ?? -1) + 1;

  const widthStr = formData.get('width');
  const heightStr = formData.get('height');
  const width = typeof widthStr === 'string' ? parseInt(widthStr, 10) || null : null;
  const height = typeof heightStr === 'string' ? parseInt(heightStr, 10) || null : null;

  const now = Date.now();
  await dbRun(
    sql,
    `INSERT INTO journal_entry_photos
       (id, entry_id, household_id, storage_key, sort_order, width, height, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, entryId, householdId, storageKey, sortOrder, width, height, now],
  );

  // Bump the entry's updated_at so sync picks up the change.
  await dbRun(
    sql,
    `UPDATE journal_entries SET updated_at = $1 WHERE id = $2`,
    [now, entryId],
  );

  const row = await dbGet<PhotoRow>(
    sql,
    `SELECT id, entry_id, household_id, storage_key, sort_order, width, height, created_at
       FROM journal_entry_photos WHERE id = $1`,
    [id],
  );
  return c.json({ ok: true, data: { photo: photoToDto(row!) } });
});

// DELETE /api/journal/photos/:photoId
journalRoutes.delete('/photos/:photoId', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const photoId = c.req.param('photoId');

  const photo = await dbGet<{ storage_key: string; entry_id: string }>(
    sql,
    `SELECT storage_key, entry_id FROM journal_entry_photos
      WHERE id = $1 AND household_id = $2`,
    [photoId, householdId],
  );
  if (!photo) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'photo not found' } }, 404);
  }

  await deletePhotoFromStorage(c.env, photo.storage_key).catch(() => { /* best-effort */ });
  await dbRun(sql, `DELETE FROM journal_entry_photos WHERE id = $1`, [photoId]);
  await dbRun(
    sql,
    `UPDATE journal_entries SET updated_at = $1 WHERE id = $2`,
    [Date.now(), photo.entry_id],
  );
  return c.json({ ok: true, data: { id: photoId } });
});
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/routes/journal.ts
git commit -m "Add journal photo upload + delete routes"
```

---

## Task 5: Checklist routes — add + toggle + delete

**Files:**
- Modify: `src/routes/journal.ts`

- [ ] **Step 1: Append checklist routes**

Append to `src/routes/journal.ts`:

```typescript
interface ChecklistRow {
  id: string;
  entry_id: string;
  text: string;
  completed: boolean;
  sort_order: number;
  updated_at: number;
}

function checklistToDto(c: ChecklistRow) {
  return {
    id: c.id, entryId: c.entry_id, text: c.text, completed: c.completed,
    sortOrder: c.sort_order, updatedAt: c.updated_at,
  };
}

// POST /api/journal/:id/checklist — add an item
journalRoutes.post('/:id/checklist', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const entryId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.text !== 'string' || !body.text.trim()) {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'text required' } }, 400);
  }

  const owner = await dbGet<{ id: string }>(
    sql,
    `SELECT id FROM journal_entries
      WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`,
    [entryId, householdId],
  );
  if (!owner) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'entry not found' } }, 404);
  }

  const maxRow = await dbGet<{ max: number | null }>(
    sql,
    `SELECT MAX(sort_order) AS max FROM journal_checklist_items WHERE entry_id = $1`,
    [entryId],
  );
  const sortOrder = (maxRow?.max ?? -1) + 1;
  const id = nanoid();
  const now = Date.now();

  await dbRun(
    sql,
    `INSERT INTO journal_checklist_items
       (id, entry_id, text, completed, sort_order, updated_at)
     VALUES ($1,$2,$3,FALSE,$4,$5)`,
    [id, entryId, body.text.trim(), sortOrder, now],
  );
  await dbRun(
    sql,
    `UPDATE journal_entries SET updated_at = $1 WHERE id = $2`,
    [now, entryId],
  );

  const row = await dbGet<ChecklistRow>(
    sql,
    `SELECT id, entry_id, text, completed, sort_order, updated_at
       FROM journal_checklist_items WHERE id = $1`,
    [id],
  );
  return c.json({ ok: true, data: { item: checklistToDto(row!) } });
});

// PATCH /api/journal/checklist/:itemId — toggle completed or edit text
journalRoutes.patch('/checklist/:itemId', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const itemId = c.req.param('itemId');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'JSON body required' } }, 400);
  }

  // Confirm the item belongs to a household-owned entry.
  const owner = await dbGet<{ entry_id: string }>(
    sql,
    `SELECT ci.entry_id FROM journal_checklist_items ci
       JOIN journal_entries je ON je.id = ci.entry_id
      WHERE ci.id = $1 AND je.household_id = $2 AND je.deleted_at IS NULL`,
    [itemId, householdId],
  );
  if (!owner) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'item not found' } }, 404);
  }

  const sets: string[] = ['updated_at = $1'];
  const params: unknown[] = [Date.now()];
  let p = 2;
  if ('text' in body && typeof body.text === 'string' && body.text.trim()) {
    sets.push(`text = $${p++}`); params.push(body.text.trim());
  }
  if ('completed' in body && typeof body.completed === 'boolean') {
    sets.push(`completed = $${p++}`); params.push(body.completed);
  }
  if ('sort_order' in body && typeof body.sort_order === 'number') {
    sets.push(`sort_order = $${p++}`); params.push(body.sort_order);
  }
  params.push(itemId);
  await dbRun(
    sql,
    `UPDATE journal_checklist_items SET ${sets.join(', ')} WHERE id = $${p}`,
    params,
  );
  await dbRun(
    sql,
    `UPDATE journal_entries SET updated_at = $1 WHERE id = $2`,
    [Date.now(), owner.entry_id],
  );

  const row = await dbGet<ChecklistRow>(
    sql,
    `SELECT id, entry_id, text, completed, sort_order, updated_at
       FROM journal_checklist_items WHERE id = $1`,
    [itemId],
  );
  return c.json({ ok: true, data: { item: checklistToDto(row!) } });
});

// DELETE /api/journal/checklist/:itemId
journalRoutes.delete('/checklist/:itemId', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const itemId = c.req.param('itemId');

  const owner = await dbGet<{ entry_id: string }>(
    sql,
    `SELECT ci.entry_id FROM journal_checklist_items ci
       JOIN journal_entries je ON je.id = ci.entry_id
      WHERE ci.id = $1 AND je.household_id = $2`,
    [itemId, householdId],
  );
  if (!owner) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'item not found' } }, 404);
  }
  await dbRun(sql, `DELETE FROM journal_checklist_items WHERE id = $1`, [itemId]);
  await dbRun(
    sql,
    `UPDATE journal_entries SET updated_at = $1 WHERE id = $2`,
    [Date.now(), owner.entry_id],
  );
  return c.json({ ok: true, data: { id: itemId } });
});
```

- [ ] **Step 2: Typecheck + commit**

```bash
bun run typecheck
git add src/routes/journal.ts
git commit -m "Add journal checklist add/toggle/delete routes"
```

---

## Task 6: Retrospective route — year-grouped entries near MM-DD

**Files:**
- Modify: `src/routes/journal.ts`

- [ ] **Step 1: Append the retrospective route**

Append to `src/routes/journal.ts`:

```typescript
// GET /api/journal/retrospective?on=MM-DD — year-grouped entries near anchor
journalRoutes.get('/retrospective', ...auth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const anchor = c.req.query('on');
  if (!anchor || !validateMmDd(anchor)) {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'on=MM-DD required' } }, 400);
  }

  const window = retrospectiveMmDdWindow(anchor);
  const rows = await dbAll<EntryRow>(
    sql,
    `SELECT id, household_id, occurred_on::text, body, seed_id, bed_id,
            planting_event_id, created_at, updated_at, deleted_at
       FROM journal_entries
      WHERE household_id = $1
        AND deleted_at IS NULL
        AND to_char(occurred_on, 'MM-DD') = ANY($2)
      ORDER BY occurred_on DESC, id DESC`,
    [householdId, window],
  );

  // Group by year. Empty years are omitted (the iOS card hides itself when
  // the years array is empty — a first-year gardener with zero history.)
  const byYear = new Map<number, ReturnType<typeof rowToDto>[]>();
  for (const r of rows) {
    const year = parseInt(r.occurred_on.slice(0, 4), 10);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year)!.push(rowToDto(r));
  }
  const years = Array.from(byYear.entries())
    .sort(([a], [b]) => b - a)
    .map(([year, entries]) => ({ year, entries }));

  return c.json({ ok: true, data: { anchor, years } });
});
```

**Important:** The retrospective route is added AFTER the entry CRUD routes (Task 3) but BEFORE the `/:id/...` photo + checklist routes are matched, because Hono matches routes in registration order and `/retrospective` is a literal path that must beat the `:id` wildcard. If your code structure interleaves them, add the retrospective route near the top of the file (right after the GET `/` feed route), not at the bottom.

- [ ] **Step 2: Verify route ordering**

Read the file and confirm `/retrospective` is registered before `/:id` patterns. If not, move it.

- [ ] **Step 3: Typecheck + commit**

```bash
bun run typecheck
git add src/routes/journal.ts
git commit -m "Add /api/journal/retrospective route (year-grouped, MM-DD ±3 fuzz)"
```

---

## Task 7: Sync envelope extension

**Files:**
- Modify: the file owning `GET /api/sync` (find via `grep -rln "/api/sync" src/`)

- [ ] **Step 1: Locate the sync route**

Run: `grep -rln "/api/sync\b" src/`
Expected output: one or two files. The route owner is the one with the actual handler (not the smoke script).

- [ ] **Step 2: Add the three new entity types to the delta-sync envelope**

The sync envelope is a `{ entityType: { entries, deletedIds, nextCursor } }` shape. Find where seeds/beds/planting_events are added and add `journal_entries`, `journal_entry_photos`, `journal_checklist_items` alongside, following the same query shape. Pattern (concrete code — adapt the exact variable names to match what's already there):

```typescript
// In the sync route handler, after the existing entity blocks:

const journalEntries = await dbAll<EntryRow>(
  sql,
  `SELECT id, household_id, occurred_on::text, body, seed_id, bed_id,
          planting_event_id, created_at, updated_at, deleted_at
     FROM journal_entries
    WHERE household_id = $1 AND updated_at > $2
    ORDER BY updated_at ASC
    LIMIT $3`,
  [householdId, sinceCursor.journal_entries ?? 0, PAGE_SIZE],
);

const journalPhotos = await dbAll<PhotoRow>(
  sql,
  `SELECT p.id, p.entry_id, p.household_id, p.storage_key, p.sort_order,
          p.width, p.height, p.created_at,
          je.updated_at AS _entry_updated
     FROM journal_entry_photos p
     JOIN journal_entries je ON je.id = p.entry_id
    WHERE p.household_id = $1 AND je.updated_at > $2
    ORDER BY je.updated_at ASC, p.sort_order ASC
    LIMIT $3`,
  [householdId, sinceCursor.journal_entry_photos ?? 0, PAGE_SIZE],
);

const journalChecklist = await dbAll<ChecklistRow & { _entry_updated: number }>(
  sql,
  `SELECT ci.id, ci.entry_id, ci.text, ci.completed, ci.sort_order, ci.updated_at
     FROM journal_checklist_items ci
     JOIN journal_entries je ON je.id = ci.entry_id
    WHERE je.household_id = $1 AND ci.updated_at > $2
    ORDER BY ci.updated_at ASC
    LIMIT $3`,
  [householdId, sinceCursor.journal_checklist_items ?? 0, PAGE_SIZE],
);

// In the response envelope:
return c.json({
  ok: true,
  data: {
    // ... existing entity types ...
    journal_entries: {
      entries: journalEntries.map(rowToDto),
      nextCursor: journalEntries.length === PAGE_SIZE
        ? journalEntries[journalEntries.length - 1].updated_at : null,
    },
    journal_entry_photos: {
      entries: journalPhotos.map(photoToDto),
      nextCursor: journalPhotos.length === PAGE_SIZE
        ? journalPhotos[journalPhotos.length - 1]._entry_updated : null,
    },
    journal_checklist_items: {
      entries: journalChecklist.map(checklistToDto),
      nextCursor: journalChecklist.length === PAGE_SIZE
        ? journalChecklist[journalChecklist.length - 1].updated_at : null,
    },
  },
});
```

**Note**: photos and checklist items don't have their own `deleted_at` — when an entry is deleted, CASCADE removes them. The sync engine on iOS should detect "parent entry's `deleted_at` is set" and prune local children, OR (cleaner) the route can include the child entity in a `deletedIds` array when parent is soft-deleted. Pick whichever pattern matches what `seed_photos` already does — read that code path first.

If `seed_photos` doesn't have parent-cascade in its sync flow either, add a `deletedChildIds` array in the response and populate it by querying photos/checklist items whose entry has `deleted_at > sinceCursor`.

- [ ] **Step 3: Typecheck + commit**

```bash
bun run typecheck
git add src/routes/<sync-file>.ts
git commit -m "Extend delta-sync envelope with journal entries, photos, checklist items"
```

---

## Task 8: Smoke script — end-to-end verification

**Files:**
- Create: `scripts/journal-smoke.ts`

- [ ] **Step 1: Write the smoke script**

Create `scripts/journal-smoke.ts`. This is the integration-test pattern used elsewhere on the server (`scripts/recommendations-smoke.ts` is the reference). It hits a running local server with a synthetic test user.

```typescript
// End-to-end smoke for the journal feature.
// Creates a synthetic household, exercises every route, asserts the
// happy-path response shapes. Run against a local server:
//
//   bun run dev                      # in another terminal
//   bun run scripts/journal-smoke.ts
//
// Exits 0 on success, 1 on any failure. Mirrors the shape of
// scripts/recommendations-smoke.ts.

const BASE = process.env.SEEDKEEP_BASE ?? 'http://localhost:8787';

// (Use the same auth-bootstrap helper that scripts/recommendations-smoke.ts
// uses. If it's exported, import it; if it's inlined there, lift it into
// scripts/lib/smoke-auth.ts as part of this task.)
import { bootstrapTestSession } from './lib/smoke-auth';

let passed = 0, failed = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) { console.log(`✓ ${label}`); passed++; }
  else { console.error(`✗ ${label}`, detail ?? ''); failed++; }
}

async function main() {
  const { authHeader, householdId } = await bootstrapTestSession(BASE);

  // 1. Empty feed
  let r = await fetch(`${BASE}/api/journal`, { headers: authHeader });
  let body = await r.json();
  ok('GET /journal returns empty feed', r.ok && body.ok && body.data.entries.length === 0);

  // 2. Create entry
  r = await fetch(`${BASE}/api/journal`, {
    method: 'POST',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ occurred_on: '2026-05-24', body: 'Planted Ozark Giant peppers.' }),
  });
  body = await r.json();
  ok('POST /journal creates entry', r.ok && body.data.entry.body === 'Planted Ozark Giant peppers.');
  const entryId: string = body.data.entry.id;

  // 3. Feed contains entry
  r = await fetch(`${BASE}/api/journal`, { headers: authHeader });
  body = await r.json();
  ok('GET /journal lists created entry', body.data.entries.length === 1 && body.data.entries[0].id === entryId);

  // 4. PATCH updates body
  r = await fetch(`${BASE}/api/journal/${entryId}`, {
    method: 'PATCH',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'Planted Ozark Giant peppers in Bed A.' }),
  });
  body = await r.json();
  ok('PATCH /journal/:id updates body', body.data.entry.body.includes('Bed A'));

  // 5. Two-attach rejection
  r = await fetch(`${BASE}/api/journal`, {
    method: 'POST',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ occurred_on: '2026-05-24', seed_id: 'fake', bed_id: 'fake' }),
  });
  body = await r.json();
  ok('POST /journal rejects two parent attachments', r.status === 400 && !body.ok);

  // 6. Add checklist item
  r = await fetch(`${BASE}/api/journal/${entryId}/checklist`, {
    method: 'POST',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Water seedlings' }),
  });
  body = await r.json();
  ok('POST /journal/:id/checklist adds item', body.data.item.text === 'Water seedlings');
  const itemId: string = body.data.item.id;

  // 7. Toggle completed
  r = await fetch(`${BASE}/api/journal/checklist/${itemId}`, {
    method: 'PATCH',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ completed: true }),
  });
  body = await r.json();
  ok('PATCH /journal/checklist/:id toggles complete', body.data.item.completed === true);

  // 8. Retrospective miss (no prior years)
  r = await fetch(`${BASE}/api/journal/retrospective?on=05-24`, { headers: authHeader });
  body = await r.json();
  ok('GET /journal/retrospective returns empty years on first-year garden', body.data.years.length === 0);

  // 9. Retrospective bad anchor
  r = await fetch(`${BASE}/api/journal/retrospective?on=13-01`, { headers: authHeader });
  body = await r.json();
  ok('GET /journal/retrospective rejects bad anchor', r.status === 400 && !body.ok);

  // 10. Soft-delete entry
  r = await fetch(`${BASE}/api/journal/${entryId}`, { method: 'DELETE', headers: authHeader });
  ok('DELETE /journal/:id soft-deletes', r.ok);

  // 11. Feed no longer shows it
  r = await fetch(`${BASE}/api/journal`, { headers: authHeader });
  body = await r.json();
  ok('Soft-deleted entry hidden from feed', body.data.entries.length === 0);

  console.log(`\n${passed}/${passed + failed} smoke checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run against local server**

In one terminal: `bun run dev`
In another: `bun run scripts/journal-smoke.ts`
Expected: `11/11 smoke checks passed`.

- [ ] **Step 3: Commit**

```bash
git add scripts/journal-smoke.ts
git commit -m "Add journal-smoke.ts end-to-end smoke (11 checks)"
```

---

## Task 9: Migration data preservation test

**Files:**
- Modify: `migrations/0011_journal.sql` (no — leave alone; this is verification only)
- Create: `src/lib/journal/__tests__/migration.test.ts` *(if your codebase has migration tests)* — or extend `scripts/journal-smoke.ts` with a pre-migration setup check.

**Per the migration-backfill memory rule**: every migration that backfills existing data MUST verify the data preservation explicitly. This task is the verification.

- [ ] **Step 1: Manual pre-flight check on local DB**

Before the test, manually verify migration 0011 ran correctly against any locally-existing `kind='note'` planting_event rows:

```bash
docker exec seedkeep-db psql -U seedkeep -d seedkeep -c "
  SELECT je.id, je.occurred_on, je.body, je.bed_id, pe.deleted_at AS source_deleted
    FROM journal_entries je
    LEFT JOIN planting_events pe ON pe.id = je.id
   WHERE pe.kind = 'note'
   LIMIT 10;"
```

Expected: every migrated entry has a matching `planting_events` row with `deleted_at` set. `body`, `bed_id`, `occurred_on` match the source.

- [ ] **Step 2: Document the manual check in the smoke script**

If `scripts/journal-smoke.ts` runs against a fresh-DB test environment (no pre-existing note events), add a comment at the top:

```typescript
// NOTE: This smoke script does NOT verify migration 0011's data
// preservation (kind='note' planting_events → journal_entries). That
// verification is manual:
//   docker exec seedkeep-db psql -U seedkeep -d seedkeep -c "..."
// Run the SQL in scripts/lib/verify-migration-0011.sql against
// any DB that has pre-existing note events before deploying.
```

- [ ] **Step 3: Write the verify-migration helper**

Create `scripts/lib/verify-migration-0011.sql`:

```sql
-- Run against any DB upgraded from a pre-0011 state to verify migration
-- 0011 preserved all kind='note' planting_events as journal_entries.
--
-- Usage:
--   docker exec seedkeep-db psql -U seedkeep -d seedkeep \
--     -f scripts/lib/verify-migration-0011.sql

SELECT
  (SELECT count(*) FROM planting_events WHERE kind = 'note') AS legacy_count,
  (SELECT count(*) FROM journal_entries je
     JOIN planting_events pe ON pe.id = je.id
    WHERE pe.kind = 'note') AS preserved_count,
  (SELECT count(*) FROM planting_events WHERE kind = 'note' AND deleted_at IS NULL)
    AS unsoftdeleted_count;

-- Expected: legacy_count == preserved_count, unsoftdeleted_count == 0.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/lib/verify-migration-0011.sql scripts/journal-smoke.ts
git commit -m "Add verify-migration-0011 SQL + smoke-script note for backfill verification"
```

---

## Task 10: Deploy to Fly + verify

**Files:**
- No file changes — verification + deploy task.

- [ ] **Step 1: Final pre-deploy gate**

Run all three:

```bash
bun run typecheck
bun run test
bun run scripts/journal-smoke.ts   # against `bun run dev` in another terminal
```

Expected: typecheck clean, all unit tests pass (count should now be 55 + new journal tests = ~60+), 11/11 smoke.

- [ ] **Step 2: Push main**

```bash
git push origin main
```

- [ ] **Step 3: Deploy**

```bash
fly deploy --ha=false
```

Expected: `release_command` runs `bun run migrate` and applies 0011. Both `app` and `worker` machines refresh. `Visit your newly deployed app at https://seedkeep-server.fly.dev/`.

- [ ] **Step 4: Verify production health**

```bash
curl -s https://seedkeep-server.fly.dev/api/health
```

Expected: `{"ok":true,"data":{"status":"healthy","env":"production"}}`.

- [ ] **Step 5: Verify migration ran on prod**

```bash
fly ssh console -a seedkeep-server -C 'sh -c "cat > /app/v.sql && psql $DATABASE_URL -f /app/v.sql"' < scripts/lib/verify-migration-0011.sql
```

Expected: `legacy_count == preserved_count, unsoftdeleted_count == 0`. If the prod DB has zero pre-existing note events, all three are 0 — also valid.

- [ ] **Step 6: Update AI docs**

Edit `.docs/ai/current-state.md` with a fresh entry at the top of "Last Session Summary":

```markdown
**Date**: YYYY-MM-DD — Phase 3 (Journal) server foundation deployed (Fly v15)

- Migration 0011 + 10 new routes + sync envelope extension + smoke (11 checks).
- 3 new tables (`journal_entries`, `journal_entry_photos`, `journal_checklist_items`).
- Legacy `planting_events.kind='note'` migrated to `journal_entries` (X rows on prod).
- Fly v15. iOS work in `seedkeep-ios/.docs/ai/plans/2026-05-24-phase-3-journal-ios.md`.
```

(Use today's date for `YYYY-MM-DD` and replace `X` with the actual count from Step 5.)

- [ ] **Step 7: Commit + push docs**

```bash
git add .docs/ai/current-state.md
git commit -m "Update current-state: Phase 3 server foundation deployed (Fly v15)"
git push origin main
```

---

## Self-review checklist (verify before marking plan complete)

- [ ] Migration 0011 covers the spec's data model (3 tables) + data migration (kind='note' rollover) + CHECK rebuild.
- [ ] All 10 routes from the spec exist in `src/routes/journal.ts`.
- [ ] Sync envelope extension covers all 3 new entity types.
- [ ] Pure-lib tests cover the retrospective MM-DD fuzz (including year-boundary wrap) and the at-most-one validation.
- [ ] Smoke script exercises each route at least once.
- [ ] Migration verification SQL is committed.
- [ ] Deploy produces a green health check + a clean verify-migration-0011 output.
