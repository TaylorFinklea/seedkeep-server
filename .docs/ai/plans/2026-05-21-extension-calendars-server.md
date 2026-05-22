# Extension Calendars v1 — Phase A (seedkeep-server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add expert-curated regional planting calendars as a higher-priority window source for the recommendation engine, so per-seed planting windows become locally authoritative where coverage exists.

**Architecture:** A new `extension_calendar_entries` table (keyed by state region + crop) is consulted *before* the rule engine. On a hit, its window is cached with `source = 'extension'`, `confidence = 1.0`; on a miss, the existing rule → AI fallback chain runs unchanged. Region is resolved from the household ZIP by a pure function. Data ships as a bundled CSV dataset; the schema is built community-ready.

**Tech Stack:** Bun, Hono, Postgres (postgres.js), Vitest. Spec: `~/git/seedkeep/.docs/ai/specs/2026-05-21-extension-calendars-design.md`.

**Plan-level decisions (refinements of the spec):**
- **v1 regions are state-level only.** Every region is a US state (2-letter code). Sub-regions (`TX-north`, etc.) are deferred to a follow-on — the schema still allows them (`regions.id` is free-form text), but no sub-region rows ship in v1.
- **Region is resolved at `PUT /location` time by a pure `zipToRegion` function** (ZIP3-prefix → state), not stored on `zip_locations`. This avoids re-seeding the 33,751-row `zip_locations` table and keeps resolution unit-testable. The spec's "`zip_locations` gains `region_id`" is satisfied equivalently by `households.region_id`.

---

## File Structure

**Created:**
- `migrations/0009_extension_calendars.sql` — schema: 3 tables, `region_id` columns, `source` enum widen, invalidation trigger.
- `src/lib/recommendation/region.ts` — pure `zipToRegion(zip)` (ZIP3 → state code).
- `src/lib/recommendation/region.test.ts` — wait, tests live in `__tests__/`. Test file: `src/lib/recommendation/__tests__/region.test.ts`.
- `src/lib/recommendation/cropMatch.ts` — pure `normalizeCropKey(commonName)`.
- `src/lib/recommendation/__tests__/cropMatch.test.ts`.
- `src/lib/recommendation/extensionBaseline.ts` — pure `resolveExtensionBaseline(entry, currentYear)`.
- `src/lib/recommendation/__tests__/extensionBaseline.test.ts`.
- `src/lib/recommendation/extensionLookup.ts` — DB lookup: `(sql, regionId, cropKey, sowMethod)` → entry row or null.
- `data/regions.csv` — 50 state regions.
- `data/crop_aliases.csv` — alias → crop_key.
- `data/extension_calendars.csv` — bundled calendar entries (starter coverage).
- `scripts/seed-extension-calendars.ts` — loads the three CSVs into Postgres.

**Modified:**
- `src/routes/households.ts` — `PUT /households/me/location` also resolves + stores `region_id`.
- `src/routes/recommendations.ts` — extension lookup before the rule engine in both `GET` and `POST /bulk`; cache writes carry `region_id`.
- `package.json` — add `seed:calendars` script.
- `scripts/recommendations-smoke.ts` — add extension-calendar checks.

---

## Task 1: Migration 0009 — schema

**Files:**
- Create: `migrations/0009_extension_calendars.sql`

- [ ] **Step 1: Write the migration file**

Create `migrations/0009_extension_calendars.sql` with exactly this content:

```sql
-- Migration: Extension calendars v1 — foundation + Authority.
--
-- Expert-curated regional planting calendars. extension_calendar_entries
-- is keyed by (region, crop, sow_method); a published entry takes
-- precedence over the rule engine. Schema is community-ready (source,
-- status, submitted_by, review columns) though v1 ships only bundled data.
-- Region is a US state code; households.region_id is resolved from the
-- home ZIP. recommendation_cache gains region_id so a calendar change can
-- invalidate every cached row for that region.

CREATE TABLE IF NOT EXISTS regions (
  id           TEXT PRIMARY KEY,        -- state code, e.g. 'VA'
  display_name TEXT NOT NULL,           -- 'Virginia'
  state_code   TEXT NOT NULL,           -- 'VA' (== id for v1 state-level regions)
  description  TEXT,
  created_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS extension_calendar_entries (
  id                 TEXT PRIMARY KEY,
  region_id          TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  crop_key           TEXT NOT NULL,                       -- 'tomato'
  sow_method         TEXT NOT NULL CHECK (sow_method IN ('direct','transplant','either')),
  window_start       TEXT NOT NULL,                       -- 'MM-DD'
  window_end         TEXT NOT NULL,                       -- 'MM-DD'
  indoor_start       TEXT,                                -- 'MM-DD' (transplant only)
  indoor_end         TEXT,
  source             TEXT NOT NULL CHECK (source IN ('bundled','community')),
  source_attribution TEXT NOT NULL,                       -- 'Virginia Cooperative Extension'
  status             TEXT NOT NULL DEFAULT 'published'
                       CHECK (status IN ('published','pending','rejected')),
  submitted_by       TEXT,                                -- household id (null for bundled)
  review_score       NUMERIC(3,2),
  confidence         NUMERIC(3,2),
  notes              TEXT,
  created_at         BIGINT NOT NULL,
  updated_at         BIGINT NOT NULL,
  UNIQUE (region_id, crop_key, sow_method, source)
);

CREATE INDEX IF NOT EXISTS idx_extension_entries_lookup
  ON extension_calendar_entries(region_id, crop_key)
  WHERE status = 'published';

CREATE TABLE IF NOT EXISTS crop_aliases (
  alias    TEXT PRIMARY KEY,   -- normalized lowercase, e.g. 'cherry tomato'
  crop_key TEXT NOT NULL       -- canonical crop, e.g. 'tomato'
);

ALTER TABLE households
  ADD COLUMN IF NOT EXISTS region_id TEXT;

ALTER TABLE recommendation_cache
  ADD COLUMN IF NOT EXISTS region_id TEXT;

-- Widen the recommendation_cache source enum to admit 'extension'.
-- A CHECK constraint cannot be appended to; drop and recreate it.
ALTER TABLE recommendation_cache
  DROP CONSTRAINT IF EXISTS recommendation_cache_source_check;
ALTER TABLE recommendation_cache
  ADD CONSTRAINT recommendation_cache_source_check
  CHECK (source IN ('rule','ai','extension'));

-- Trigger: a calendar change wipes every cached row for that region.
-- Coarse (whole region, not per-crop) — calendar data changes rarely,
-- so simplicity beats precision. Fires on INSERT/UPDATE/DELETE.
CREATE OR REPLACE FUNCTION invalidate_recommendation_on_calendar()
RETURNS trigger AS $$
BEGIN
  DELETE FROM recommendation_cache
   WHERE region_id = COALESCE(NEW.region_id, OLD.region_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_calendar_invalidates_recommendation ON extension_calendar_entries;
CREATE TRIGGER trg_calendar_invalidates_recommendation
  AFTER INSERT OR UPDATE OR DELETE ON extension_calendar_entries
  FOR EACH ROW
  EXECUTE FUNCTION invalidate_recommendation_on_calendar();

-- Extend the household-location trigger to also fire when region_id
-- changes (region is resolved alongside zone/frost at PUT /location time).
CREATE OR REPLACE FUNCTION invalidate_recommendation_on_household()
RETURNS trigger AS $$
BEGIN
  DELETE FROM recommendation_cache
   WHERE (OLD.usda_zone IS NOT NULL AND location_signature LIKE OLD.usda_zone || ':%')
      OR (NEW.usda_zone IS NOT NULL AND location_signature LIKE NEW.usda_zone || ':%')
      OR (OLD.region_id IS NOT NULL AND region_id = OLD.region_id)
      OR (NEW.region_id IS NOT NULL AND region_id = NEW.region_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_household_invalidates_recommendation ON households;
CREATE TRIGGER trg_household_invalidates_recommendation
  AFTER UPDATE ON households
  FOR EACH ROW
  WHEN (
    OLD.usda_zone       IS DISTINCT FROM NEW.usda_zone OR
    OLD.avg_last_frost  IS DISTINCT FROM NEW.avg_last_frost OR
    OLD.avg_first_frost IS DISTINCT FROM NEW.avg_first_frost OR
    OLD.latitude        IS DISTINCT FROM NEW.latitude OR
    OLD.longitude       IS DISTINCT FROM NEW.longitude OR
    OLD.region_id       IS DISTINCT FROM NEW.region_id
  )
  EXECUTE FUNCTION invalidate_recommendation_on_household();
```

- [ ] **Step 2: Run the migration**

Run: `cd ~/git/seedkeep-server && bun run migrate`
Expected: output lists `0009_extension_calendars.sql` as applied, exit 0. (Requires local Postgres up: `docker compose up -d db`.)

- [ ] **Step 3: Verify the schema**

Run: `cd ~/git/seedkeep-server && docker compose exec -T db psql -U seedkeep -d seedkeep -c "\d extension_calendar_entries" -c "\d regions" -c "\d crop_aliases" -c "SELECT conname FROM pg_constraint WHERE conname = 'recommendation_cache_source_check';"`
Expected: all three tables print their columns; the constraint row prints. (If the DB user/name differ, use the values from `docker-compose.yml`.)

- [ ] **Step 4: Verify idempotency**

Run: `cd ~/git/seedkeep-server && bun run migrate`
Expected: `0009` is NOT re-applied (already in `_seedkeep_migrations`); exit 0.

- [ ] **Step 5: Commit**

```bash
cd ~/git/seedkeep-server
git add migrations/0009_extension_calendars.sql
git commit -m "Add migration 0009: extension-calendar tables + triggers"
```

---

## Task 2: `zipToRegion` — pure ZIP → state-region resolver

**Files:**
- Create: `src/lib/recommendation/region.ts`
- Test: `src/lib/recommendation/__tests__/region.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/recommendation/__tests__/region.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { zipToRegion } from '../region';

describe('zipToRegion', () => {
  it('maps a New York ZIP to NY', () => {
    expect(zipToRegion('10001')).toBe('NY');
  });

  it('maps a California ZIP to CA', () => {
    expect(zipToRegion('90001')).toBe('CA');
  });

  it('maps a Virginia ZIP to VA', () => {
    expect(zipToRegion('23220')).toBe('VA');
  });

  it('returns null for a non-5-digit string', () => {
    expect(zipToRegion('abcde')).toBeNull();
    expect(zipToRegion('123')).toBeNull();
  });

  it('returns null for a ZIP3 prefix in no assigned range', () => {
    // 000-004 are unassigned.
    expect(zipToRegion('00100')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/git/seedkeep-server && bunx vitest run src/lib/recommendation/__tests__/region.test.ts`
Expected: FAIL — `Cannot find module '../region'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/recommendation/region.ts`. The ZIP3-prefix → state ranges below are the standard USPS assignment; each tuple is `[lowZip3, highZip3, stateCode]` inclusive:

```typescript
// Pure ZIP -> US state resolver. Extension calendars are keyed by state
// region (v1); a household's region is derived from its home ZIP. ZIP3
// prefixes are assigned to states by USPS in contiguous ranges.

type Range = [number, number, string];

// ZIP3-prefix ranges by state (USPS assignment). Inclusive bounds.
const ZIP3_RANGES: Range[] = [
  [5, 5, 'NY'], [6, 9, 'PR'], [10, 27, 'MA'], [28, 29, 'RI'],
  [30, 38, 'NH'], [39, 49, 'MA'], [50, 54, 'VT'], [55, 55, 'MA'],
  [56, 59, 'VT'], [60, 69, 'CT'], [70, 89, 'NJ'], [90, 99, 'AP'],
  [100, 149, 'NY'], [150, 196, 'PA'], [197, 199, 'DE'],
  [200, 205, 'DC'], [206, 219, 'MD'], [220, 246, 'VA'],
  [247, 268, 'WV'], [270, 289, 'NC'], [290, 299, 'SC'],
  [300, 319, 'GA'], [320, 349, 'FL'], [350, 369, 'AL'],
  [370, 385, 'TN'], [386, 397, 'MS'], [398, 399, 'GA'],
  [400, 427, 'KY'], [430, 459, 'OH'], [460, 479, 'IN'],
  [480, 499, 'MI'], [500, 528, 'IA'], [530, 549, 'WI'],
  [550, 567, 'MN'], [570, 577, 'SD'], [580, 588, 'ND'],
  [590, 599, 'MT'], [600, 629, 'IL'], [630, 658, 'MO'],
  [660, 679, 'KS'], [680, 693, 'NE'], [700, 714, 'LA'],
  [716, 729, 'AR'], [730, 749, 'OK'], [750, 799, 'TX'],
  [800, 816, 'CO'], [820, 831, 'WY'], [832, 838, 'ID'],
  [840, 847, 'UT'], [850, 865, 'AZ'], [870, 884, 'NM'],
  [889, 898, 'NV'], [900, 961, 'CA'], [967, 968, 'HI'],
  [969, 969, 'GU'], [970, 979, 'OR'], [980, 994, 'WA'],
  [995, 999, 'AK'],
];

export function zipToRegion(zip: string): string | null {
  if (!/^\d{5}$/.test(zip)) return null;
  const prefix = parseInt(zip.slice(0, 3), 10);
  for (const [lo, hi, state] of ZIP3_RANGES) {
    if (prefix >= lo && prefix <= hi) return state;
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/git/seedkeep-server && bunx vitest run src/lib/recommendation/__tests__/region.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/git/seedkeep-server
git add src/lib/recommendation/region.ts src/lib/recommendation/__tests__/region.test.ts
git commit -m "Add zipToRegion: pure ZIP -> state-region resolver"
```

---

## Task 3: `normalizeCropKey` — pure crop-name normalizer

**Files:**
- Create: `src/lib/recommendation/cropMatch.ts`
- Test: `src/lib/recommendation/__tests__/cropMatch.test.ts`

`normalizeCropKey` lowercases, trims, and collapses internal whitespace. It does NOT strip variety words — alias resolution (the `crop_aliases` table) handles "cherry tomato" → "tomato". This keeps the function pure and the messy mapping in data.

- [ ] **Step 1: Write the failing test**

Create `src/lib/recommendation/__tests__/cropMatch.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeCropKey } from '../cropMatch';

describe('normalizeCropKey', () => {
  it('lowercases', () => {
    expect(normalizeCropKey('Tomato')).toBe('tomato');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeCropKey('  Lettuce  ')).toBe('lettuce');
  });

  it('collapses internal whitespace', () => {
    expect(normalizeCropKey('Cherry   Tomato')).toBe('cherry tomato');
  });

  it('leaves an already-normalized key unchanged', () => {
    expect(normalizeCropKey('snap bean')).toBe('snap bean');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/git/seedkeep-server && bunx vitest run src/lib/recommendation/__tests__/cropMatch.test.ts`
Expected: FAIL — `Cannot find module '../cropMatch'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/recommendation/cropMatch.ts`:

```typescript
// Pure normalization of a catalog common_name into a crop-alias lookup
// key. Alias -> canonical crop_key resolution is a crop_aliases table
// lookup, not done here, so this stays a pure string function.

export function normalizeCropKey(commonName: string): string {
  return commonName.trim().toLowerCase().replace(/\s+/g, ' ');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/git/seedkeep-server && bunx vitest run src/lib/recommendation/__tests__/cropMatch.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/git/seedkeep-server
git add src/lib/recommendation/cropMatch.ts src/lib/recommendation/__tests__/cropMatch.test.ts
git commit -m "Add normalizeCropKey: pure crop-name normalizer"
```

---

## Task 4: `resolveExtensionBaseline` — pure MM-DD entry → dated baseline

**Files:**
- Create: `src/lib/recommendation/extensionBaseline.ts`
- Test: `src/lib/recommendation/__tests__/extensionBaseline.test.ts`

This converts a calendar entry's recurring MM-DD windows into the same `RuleBaseline` shape the route already caches, resolved to `currentYear`. `confidence` is fixed at `1.0` — an extension entry is authoritative.

- [ ] **Step 1: Write the failing test**

Create `src/lib/recommendation/__tests__/extensionBaseline.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveExtensionBaseline } from '../extensionBaseline';
import type { ExtensionEntry } from '../extensionBaseline';

const DIRECT_ENTRY: ExtensionEntry = {
  windowStart: '04-15', windowEnd: '06-30',
  indoorStart: null, indoorEnd: null,
  sourceAttribution: 'Virginia Cooperative Extension',
};

describe('resolveExtensionBaseline', () => {
  it('resolves MM-DD windows to YYYY-MM-DD for the given year', () => {
    const b = resolveExtensionBaseline(DIRECT_ENTRY, 2026);
    expect(b.windowStart).toBe('2026-04-15');
    expect(b.windowEnd).toBe('2026-06-30');
  });

  it('confidence is 1.0 and source is extension', () => {
    const b = resolveExtensionBaseline(DIRECT_ENTRY, 2026);
    expect(b.confidence).toBe(1.0);
    expect(b.source).toBe('extension');
  });

  it('reasoning credits the source attribution', () => {
    const b = resolveExtensionBaseline(DIRECT_ENTRY, 2026);
    expect(b.reasoning).toBe('Per Virginia Cooperative Extension');
  });

  it('resolves an indoor window when present', () => {
    const b = resolveExtensionBaseline(
      { ...DIRECT_ENTRY, indoorStart: '02-15', indoorEnd: '03-15' }, 2026,
    );
    expect(b.indoorStart).toBe('2026-02-15');
    expect(b.indoorEnd).toBe('2026-03-15');
  });

  it('leaves indoor window null when the entry has none', () => {
    const b = resolveExtensionBaseline(DIRECT_ENTRY, 2026);
    expect(b.indoorStart).toBeNull();
    expect(b.indoorEnd).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/git/seedkeep-server && bunx vitest run src/lib/recommendation/__tests__/extensionBaseline.test.ts`
Expected: FAIL — `Cannot find module '../extensionBaseline'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/recommendation/extensionBaseline.ts`:

```typescript
// Pure conversion of an extension_calendar_entries row (recurring MM-DD
// windows) into a dated baseline for currentYear. Shares the cache shape
// the route writes for rule/ai sources. An extension entry is
// authoritative: confidence is always 1.0, so it never triggers AI.

export interface ExtensionEntry {
  windowStart: string;        // 'MM-DD'
  windowEnd: string;          // 'MM-DD'
  indoorStart: string | null; // 'MM-DD'
  indoorEnd: string | null;
  sourceAttribution: string;
}

export interface ExtensionBaseline {
  windowStart: string;        // 'YYYY-MM-DD'
  windowEnd: string;
  indoorStart: string | null;
  indoorEnd: string | null;
  confidence: number;
  reasoning: string;
  source: 'extension';
}

function dateFor(year: number, mmdd: string): string {
  return `${year}-${mmdd}`;
}

export function resolveExtensionBaseline(
  entry: ExtensionEntry,
  currentYear: number,
): ExtensionBaseline {
  return {
    windowStart: dateFor(currentYear, entry.windowStart),
    windowEnd: dateFor(currentYear, entry.windowEnd),
    indoorStart: entry.indoorStart ? dateFor(currentYear, entry.indoorStart) : null,
    indoorEnd: entry.indoorEnd ? dateFor(currentYear, entry.indoorEnd) : null,
    confidence: 1.0,
    reasoning: `Per ${entry.sourceAttribution}`,
    source: 'extension',
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/git/seedkeep-server && bunx vitest run src/lib/recommendation/__tests__/extensionBaseline.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/git/seedkeep-server
git add src/lib/recommendation/extensionBaseline.ts src/lib/recommendation/__tests__/extensionBaseline.test.ts
git commit -m "Add resolveExtensionBaseline: MM-DD entry -> dated baseline"
```

---

## Task 5: Bundled dataset CSV files

**Files:**
- Create: `data/regions.csv`
- Create: `data/crop_aliases.csv`
- Create: `data/extension_calendars.csv`

The dataset is curated reference data. `regions.csv` lists all 50 states (mechanical — region coverage of *calendar entries* is what's partial). `crop_aliases.csv` covers the crops the v1 calendar uses. `extension_calendars.csv` is the v1 starter coverage: this plan ships entries for **two states (VA, CA)** as a worked, structurally-complete starter set; coverage expands by appending rows (no schema or code change). Window dates below are reasonable cool/warm-season values; the data curator should reconcile them against each state's published cooperative-extension planting guide before release.

- [ ] **Step 1: Create `data/regions.csv`**

```
id,display_name,state_code
AL,Alabama,AL
AK,Alaska,AK
AZ,Arizona,AZ
AR,Arkansas,AR
CA,California,CA
CO,Colorado,CO
CT,Connecticut,CT
DE,Delaware,DE
FL,Florida,FL
GA,Georgia,GA
HI,Hawaii,HI
ID,Idaho,ID
IL,Illinois,IL
IN,Indiana,IN
IA,Iowa,IA
KS,Kansas,KS
KY,Kentucky,KY
LA,Louisiana,LA
ME,Maine,ME
MD,Maryland,MD
MA,Massachusetts,MA
MI,Michigan,MI
MN,Minnesota,MN
MS,Mississippi,MS
MO,Missouri,MO
MT,Montana,MT
NE,Nebraska,NE
NV,Nevada,NV
NH,New Hampshire,NH
NJ,New Jersey,NJ
NM,New Mexico,NM
NY,New York,NY
NC,North Carolina,NC
ND,North Dakota,ND
OH,Ohio,OH
OK,Oklahoma,OK
OR,Oregon,OR
PA,Pennsylvania,PA
RI,Rhode Island,RI
SC,South Carolina,SC
SD,South Dakota,SD
TN,Tennessee,TN
TX,Texas,TX
UT,Utah,UT
VT,Vermont,VT
VA,Virginia,VA
WA,Washington,WA
WV,West Virginia,WV
WI,Wisconsin,WI
WY,Wyoming,WY
```

- [ ] **Step 2: Create `data/crop_aliases.csv`**

Each canonical crop has a self-row plus common variety aliases. `alias` is the normalized lowercase `common_name`.

```
alias,crop_key
tomato,tomato
cherry tomato,tomato
roma tomato,tomato
slicing tomato,tomato
lettuce,lettuce
leaf lettuce,lettuce
romaine,lettuce
romaine lettuce,lettuce
basil,basil
sweet basil,basil
genovese basil,basil
pepper,pepper
bell pepper,pepper
sweet pepper,pepper
hot pepper,pepper
carrot,carrot
cucumber,cucumber
snap bean,snap bean
bush bean,snap bean
green bean,snap bean
pole bean,snap bean
zucchini,zucchini
summer squash,zucchini
pea,pea
snap pea,pea
snow pea,pea
spinach,spinach
kale,kale
radish,radish
beet,beet
```

- [ ] **Step 3: Create `data/extension_calendars.csv`**

`source` is `bundled` and `status` is `published` for every row. Empty `indoor_start`/`indoor_end` cells mean null.

```
region_id,crop_key,sow_method,window_start,window_end,indoor_start,indoor_end,source,source_attribution
VA,tomato,transplant,05-05,06-20,03-15,04-05,bundled,Virginia Cooperative Extension
VA,pepper,transplant,05-10,06-15,03-15,04-05,bundled,Virginia Cooperative Extension
VA,basil,transplant,05-10,07-01,04-01,04-20,bundled,Virginia Cooperative Extension
VA,lettuce,direct,03-15,05-01,,,bundled,Virginia Cooperative Extension
VA,carrot,direct,03-20,05-15,,,bundled,Virginia Cooperative Extension
VA,snap bean,direct,05-01,07-01,,,bundled,Virginia Cooperative Extension
VA,cucumber,direct,05-05,06-30,,,bundled,Virginia Cooperative Extension
VA,pea,direct,03-01,04-10,,,bundled,Virginia Cooperative Extension
VA,spinach,direct,03-01,04-15,,,bundled,Virginia Cooperative Extension
VA,radish,direct,03-10,05-01,,,bundled,Virginia Cooperative Extension
VA,kale,direct,03-15,05-01,,,bundled,Virginia Cooperative Extension
VA,beet,direct,03-20,05-15,,,bundled,Virginia Cooperative Extension
VA,zucchini,direct,05-05,06-30,,,bundled,Virginia Cooperative Extension
CA,tomato,transplant,03-15,05-15,01-15,02-15,bundled,UC Cooperative Extension
CA,pepper,transplant,04-01,05-20,02-01,03-01,bundled,UC Cooperative Extension
CA,basil,transplant,04-15,06-15,03-01,03-20,bundled,UC Cooperative Extension
CA,lettuce,direct,02-01,04-15,,,bundled,UC Cooperative Extension
CA,carrot,direct,02-15,05-01,,,bundled,UC Cooperative Extension
CA,snap bean,direct,04-01,07-01,,,bundled,UC Cooperative Extension
CA,cucumber,direct,04-01,06-15,,,bundled,UC Cooperative Extension
CA,pea,direct,01-15,03-01,,,bundled,UC Cooperative Extension
CA,spinach,direct,01-15,03-15,,,bundled,UC Cooperative Extension
CA,radish,direct,02-01,05-01,,,bundled,UC Cooperative Extension
CA,kale,direct,02-01,04-01,,,bundled,UC Cooperative Extension
CA,beet,direct,02-01,04-15,,,bundled,UC Cooperative Extension
CA,zucchini,direct,04-01,06-15,,,bundled,UC Cooperative Extension
```

- [ ] **Step 4: Commit**

```bash
cd ~/git/seedkeep-server
git add data/regions.csv data/crop_aliases.csv data/extension_calendars.csv
git commit -m "Add bundled extension-calendar dataset (VA + CA starter coverage)"
```

---

## Task 6: `seed:calendars` script

**Files:**
- Create: `scripts/seed-extension-calendars.ts`
- Modify: `package.json` (add the `seed:calendars` script)

Loads the three CSVs into `regions`, `crop_aliases`, `extension_calendar_entries`. Validates each row and aborts on the first malformed one. Idempotent via `ON CONFLICT`. Mirrors `scripts/seed-zip-locations.ts`.

- [ ] **Step 1: Write the seed script**

Create `scripts/seed-extension-calendars.ts`:

```typescript
// Loads the bundled extension-calendar dataset (data/regions.csv,
// data/crop_aliases.csv, data/extension_calendars.csv) into Postgres.
// Validates every row; aborts on the first malformed row. Idempotent.
// Run: bun run seed:calendars

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { getSql, closeDb } from '../src/db/client';
import { dbBatch } from '../src/db/helpers';

const DATA_DIR = join(import.meta.dir, '..', 'data');
const MMDD = /^\d{2}-\d{2}$/;
const SOW_METHODS = new Set(['direct', 'transplant', 'either']);

function readCsv(file: string): string[][] {
  const text = readFileSync(join(DATA_DIR, file), 'utf8').trim();
  const lines = text.split('\n');
  lines.shift(); // drop header
  return lines.map((l) => l.split(',').map((c) => c.trim()));
}

function fail(file: string, lineNo: number, msg: string): never {
  throw new Error(`${file} line ${lineNo + 2}: ${msg}`);
}

async function main() {
  const sql = getSql(process.env as Record<string, string>);
  const now = Date.now();

  // --- regions ---
  const regionRows = readCsv('regions.csv');
  const regionStmts = regionRows.map(([id, displayName, stateCode], i) => {
    if (!id || !displayName || !stateCode) fail('regions.csv', i, 'empty field');
    return {
      query: `INSERT INTO regions (id, display_name, state_code, created_at)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (id) DO UPDATE SET
                display_name = EXCLUDED.display_name,
                state_code = EXCLUDED.state_code`,
      params: [id, displayName, stateCode, now],
    };
  });
  await dbBatch(sql, regionStmts);
  console.log(`  regions: ${regionStmts.length} upserted`);

  // --- crop_aliases ---
  const aliasRows = readCsv('crop_aliases.csv');
  const aliasStmts = aliasRows.map(([alias, cropKey], i) => {
    if (!alias || !cropKey) fail('crop_aliases.csv', i, 'empty field');
    return {
      query: `INSERT INTO crop_aliases (alias, crop_key) VALUES ($1, $2)
              ON CONFLICT (alias) DO UPDATE SET crop_key = EXCLUDED.crop_key`,
      params: [alias, cropKey],
    };
  });
  await dbBatch(sql, aliasStmts);
  console.log(`  crop_aliases: ${aliasStmts.length} upserted`);

  // --- extension_calendar_entries ---
  const entryRows = readCsv('extension_calendars.csv');
  const entryStmts = entryRows.map((row, i) => {
    const [regionId, cropKey, sowMethod, windowStart, windowEnd,
           indoorStart, indoorEnd, source, attribution] = row;
    if (!regionId || !cropKey || !attribution) fail('extension_calendars.csv', i, 'empty required field');
    if (!SOW_METHODS.has(sowMethod)) fail('extension_calendars.csv', i, `bad sow_method '${sowMethod}'`);
    if (!MMDD.test(windowStart) || !MMDD.test(windowEnd)) {
      fail('extension_calendars.csv', i, 'window dates must be MM-DD');
    }
    if (indoorStart && !MMDD.test(indoorStart)) fail('extension_calendars.csv', i, 'indoor_start must be MM-DD');
    if (indoorEnd && !MMDD.test(indoorEnd)) fail('extension_calendars.csv', i, 'indoor_end must be MM-DD');
    if (source !== 'bundled') fail('extension_calendars.csv', i, "source must be 'bundled'");
    return {
      query: `INSERT INTO extension_calendar_entries
                (id, region_id, crop_key, sow_method, window_start, window_end,
                 indoor_start, indoor_end, source, source_attribution,
                 status, created_at, updated_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'published',$11,$11)
              ON CONFLICT (region_id, crop_key, sow_method, source) DO UPDATE SET
                window_start = EXCLUDED.window_start,
                window_end = EXCLUDED.window_end,
                indoor_start = EXCLUDED.indoor_start,
                indoor_end = EXCLUDED.indoor_end,
                source_attribution = EXCLUDED.source_attribution,
                updated_at = EXCLUDED.updated_at`,
      params: [nanoid(), regionId, cropKey, sowMethod, windowStart, windowEnd,
               indoorStart || null, indoorEnd || null, source, attribution, now],
    };
  });
  await dbBatch(sql, entryStmts);
  console.log(`  extension_calendar_entries: ${entryStmts.length} upserted`);

  console.log('Done — extension-calendar dataset seeded.');
  await closeDb();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Add the `seed:calendars` script to `package.json`**

In `package.json`, in the `scripts` block, add this line after the `"seed:zip"` line:

```json
    "seed:calendars": "bun run scripts/seed-extension-calendars.ts",
```

- [ ] **Step 3: Run the seed script**

Run: `cd ~/git/seedkeep-server && bun run seed:calendars`
Expected: prints `regions: 50 upserted`, `crop_aliases: 30 upserted`, `extension_calendar_entries: 26 upserted`, `Done`. Exit 0.

- [ ] **Step 4: Verify idempotency**

Run: `cd ~/git/seedkeep-server && bun run seed:calendars`
Expected: same counts, exit 0 (re-run upserts cleanly).

- [ ] **Step 5: Verify the data landed**

Run: `cd ~/git/seedkeep-server && docker compose exec -T db psql -U seedkeep -d seedkeep -c "SELECT region_id, crop_key, sow_method FROM extension_calendar_entries WHERE region_id = 'VA' ORDER BY crop_key;"`
Expected: 13 VA rows.

- [ ] **Step 6: Commit**

```bash
cd ~/git/seedkeep-server
git add scripts/seed-extension-calendars.ts package.json
git commit -m "Add seed:calendars script for the extension-calendar dataset"
```

---

## Task 7: Region resolution in `PUT /households/me/location`

**Files:**
- Modify: `src/routes/households.ts` (the `PUT /households/me/location` handler)

The handler must resolve the ZIP to a `region_id` via `zipToRegion` and store it on the household alongside the existing location columns.

- [ ] **Step 1: Import `zipToRegion`**

In `src/routes/households.ts`, add this import alongside the existing imports near the top of the file:

```typescript
import { zipToRegion } from '../lib/recommendation/region';
```

- [ ] **Step 2: Resolve and store `region_id` in the handler**

In the `PUT /households/me/location` handler, replace the `UPDATE households` call and its surrounding lines (from `const now = Date.now();` through the `await dbRun(...)` call) with:

```typescript
  const now = Date.now();
  const regionId = zipToRegion(loc.zip);
  await dbRun(
    sql,
    `UPDATE households
        SET home_zip = $1, latitude = $2, longitude = $3, usda_zone = $4,
            avg_last_frost = $5, avg_first_frost = $6, region_id = $7, updated_at = $8
      WHERE id = $9`,
    [loc.zip, loc.latitude, loc.longitude, loc.usda_zone,
     loc.avg_last_frost, loc.avg_first_frost, regionId, now, householdId],
  );
```

- [ ] **Step 3: Include `regionId` in the response**

In the same handler, replace the `return c.json({ ok: true, data: { ... } });` block with:

```typescript
  return c.json({ ok: true, data: {
    zip: loc.zip,
    latitude: loc.latitude,
    longitude: loc.longitude,
    usdaZone: loc.usda_zone,
    avgLastFrost: loc.avg_last_frost,
    avgFirstFrost: loc.avg_first_frost,
    regionId,
  } });
```

- [ ] **Step 4: Typecheck**

Run: `cd ~/git/seedkeep-server && bun run typecheck`
Expected: clean, exit 0.

- [ ] **Step 5: Commit**

```bash
cd ~/git/seedkeep-server
git add src/routes/households.ts
git commit -m "Resolve household region_id from ZIP on PUT /location"
```

---

## Task 8: Extension lookup helper

**Files:**
- Create: `src/lib/recommendation/extensionLookup.ts`

A DB helper: given a region, a catalog seed's `common_name`, and its `sow_method`, return the matching published `ExtensionEntry` (the shape `resolveExtensionBaseline` consumes) or null. Resolves the alias, then queries with `sow_method` precedence (exact method, then `either`).

- [ ] **Step 1: Write the implementation**

Create `src/lib/recommendation/extensionLookup.ts`:

```typescript
// DB lookup for an extension calendar entry covering a (region, crop,
// sow_method). Returns the ExtensionEntry shape consumed by
// resolveExtensionBaseline, or null on any miss (no region, no alias
// match, no published entry).

import type { getSql } from '../../db/client';
import { dbGet } from '../../db/helpers';
import { normalizeCropKey } from './cropMatch';
import type { ExtensionEntry } from './extensionBaseline';

interface AliasRow { crop_key: string }
interface EntryRow {
  window_start: string;
  window_end: string;
  indoor_start: string | null;
  indoor_end: string | null;
  source_attribution: string;
}

export async function lookupExtensionEntry(
  sql: ReturnType<typeof getSql>,
  regionId: string | null,
  commonName: string,
  sowMethod: string | null,
): Promise<ExtensionEntry | null> {
  if (!regionId) return null;

  const alias = await dbGet<AliasRow>(
    sql,
    `SELECT crop_key FROM crop_aliases WHERE alias = $1 LIMIT 1`,
    [normalizeCropKey(commonName)],
  );
  if (!alias) return null;

  // sow_method precedence: an entry whose method matches the seed's wins
  // over an 'either' entry; a seed with no method prefers a 'direct' entry.
  const wanted = sowMethod ?? 'direct';
  const entry = await dbGet<EntryRow>(
    sql,
    `SELECT window_start, window_end, indoor_start, indoor_end, source_attribution
       FROM extension_calendar_entries
      WHERE region_id = $1 AND crop_key = $2 AND status = 'published'
        AND sow_method IN ($3, 'either')
      ORDER BY (sow_method = $3) DESC
      LIMIT 1`,
    [regionId, alias.crop_key, wanted],
  );
  if (!entry) return null;

  return {
    windowStart: entry.window_start,
    windowEnd: entry.window_end,
    indoorStart: entry.indoor_start,
    indoorEnd: entry.indoor_end,
    sourceAttribution: entry.source_attribution,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd ~/git/seedkeep-server && bun run typecheck`
Expected: clean, exit 0.

- [ ] **Step 3: Commit**

```bash
cd ~/git/seedkeep-server
git add src/lib/recommendation/extensionLookup.ts
git commit -m "Add lookupExtensionEntry: region+crop -> calendar entry"
```

---

## Task 9: Wire extension lookup into the recommendation route

**Files:**
- Modify: `src/routes/recommendations.ts`

On a cache miss, consult the extension calendar before the rule engine. A hit caches `source = 'extension'`, `confidence = 1.0`, `region_id` set; a miss runs the existing rule → AI chain. All cache writes now also set `region_id`.

> **Note for the implementer:** this task modifies existing handler code whose exact line numbers depend on the file. The instructions below describe the precise edits in terms of the existing functions (`assembleRecommendation`, the cache-miss block in `GET`, the cache-miss block in `POST /bulk`, and every `INSERT INTO recommendation_cache`). Read the file first, then apply each edit.

- [ ] **Step 1: Add imports**

In `src/routes/recommendations.ts`, add alongside the existing recommendation-lib imports:

```typescript
import { lookupExtensionEntry } from '../lib/recommendation/extensionLookup';
import { resolveExtensionBaseline } from '../lib/recommendation/extensionBaseline';
```

- [ ] **Step 2: Add a shared extension-baseline helper**

Near the other module-level helpers in the file (e.g. just above `assembleRecommendation`), add:

```typescript
// Try the extension calendar before the rule engine. Returns a baseline
// ready to cache (source 'extension', confidence 1.0) or null on a miss.
async function tryExtensionBaseline(
  sql: ReturnType<typeof getSql>,
  regionId: string | null,
  commonName: string,
  sowMethod: string | null,
  currentYear: number,
) {
  const entry = await lookupExtensionEntry(sql, regionId, commonName, sowMethod);
  return entry ? resolveExtensionBaseline(entry, currentYear) : null;
}
```

(`getSql` is already imported at the top of `recommendations.ts`; `ReturnType<typeof getSql>` is the `sql`-parameter type the file's existing helpers — `loadLocation`, `writeCache` — use.)

- [ ] **Step 3: Load `region_id` with the household location**

The handlers call a `loadLocation()`-style helper that reads the household's location row. Extend its `SELECT` to also fetch `region_id`, and include `region_id` on the returned object. If the location is loaded via an inline query, add `region_id` to that `SELECT` and carry it through. The value is needed in Steps 4-6.

- [ ] **Step 4: Insert the extension step in the `GET` cache-miss path**

In the `GET /api/recommendations/:catalogSeedId` handler, the cache-miss path currently calls `computeRuleBaseline(...)` then decides rule-vs-AI. Immediately *before* the `computeRuleBaseline` call, add:

```typescript
    const currentYear = new Date().getUTCFullYear();
    const ext = await tryExtensionBaseline(
      sql, location.region_id, catalog.common_name, catalog.sow_method, currentYear,
    );
    if (ext) {
      await dbRun(
        sql,
        `INSERT INTO recommendation_cache
           (catalog_seed_id, location_signature, region_id, computed_at, source,
            confidence, window_start, window_end, indoor_start, indoor_end,
            reasoning, inputs_used)
         VALUES ($1,$2,$3,$4,'extension',$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (catalog_seed_id, location_signature) DO UPDATE SET
           region_id = EXCLUDED.region_id, computed_at = EXCLUDED.computed_at,
           source = EXCLUDED.source, confidence = EXCLUDED.confidence,
           window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end,
           indoor_start = EXCLUDED.indoor_start, indoor_end = EXCLUDED.indoor_end,
           reasoning = EXCLUDED.reasoning, inputs_used = EXCLUDED.inputs_used`,
        [catalogSeedId, locationSig, location.region_id, Date.now(),
         ext.confidence, ext.windowStart, ext.windowEnd, ext.indoorStart,
         ext.indoorEnd, ext.reasoning, JSON.stringify(['extension_calendar'])],
      );
      return c.json({ ok: true, data: assembleRecommendation(/* the same args
        the existing post-cache-write return uses */) });
    }
```

Match the exact variable names already in scope (`catalogSeedId`, `locationSig`/`locationSignature`, `catalog`, `location`) and the exact `assembleRecommendation(...)` call shape used by the existing rule-baseline return immediately below it.

- [ ] **Step 5: Insert the extension step in the `POST /bulk` cache-miss path**

In `POST /api/recommendations/bulk`, the per-ID loop runs the rule engine on a cache miss. Before the `computeRuleBaseline` call inside that loop, add the same extension check; on a hit, write the `source = 'extension'` cache row (same `INSERT` as Step 4, with the loop's per-ID variables) and `continue` to the next ID (skip enqueuing a job — an extension hit is complete, never `pending`).

- [ ] **Step 6: Add `region_id` to the existing rule/AI cache writes**

Every other `INSERT INTO recommendation_cache` in this file (the rule-baseline write and the AI-baseline write) must also set `region_id`. Add `region_id` to each `INSERT` column list and pass `location.region_id` as its parameter, and add `region_id = EXCLUDED.region_id` to each `ON CONFLICT DO UPDATE SET` clause. This keeps the calendar-invalidation trigger able to target rule/AI rows too.

- [ ] **Step 7: Typecheck**

Run: `cd ~/git/seedkeep-server && bun run typecheck`
Expected: clean, exit 0.

- [ ] **Step 8: Run the full unit suite**

Run: `cd ~/git/seedkeep-server && bun run test`
Expected: PASS — all existing tests plus the 14 new ones from Tasks 2-4 (region: 5, cropMatch: 4, extensionBaseline: 5).

- [ ] **Step 9: Commit**

```bash
cd ~/git/seedkeep-server
git add src/routes/recommendations.ts
git commit -m "Consult extension calendars before the rule engine"
```

---

## Task 10: Smoke-test the extension path

**Files:**
- Modify: `scripts/recommendations-smoke.ts`

Add coverage that an extension-covered seed reports `source: extension`, and that changing a calendar entry invalidates the region's cache.

- [ ] **Step 1: Read the smoke script**

Read `scripts/recommendations-smoke.ts` in full. Note: how it creates the test household, how it sets the household location (it PUTs a ZIP), how it creates a `catalog_seeds` fixture, and how each numbered check is structured (`check(n, description, condition)` style).

- [ ] **Step 2: Add the extension checks**

After the existing check 9 (and before the cleanup block), add two checks. Use a ZIP whose `zipToRegion` resolves to `VA` (e.g. `23220`) for the test household — confirm that ZIP is present in `zip_locations` first; if not, use any ZIP in `data/zip_locations.csv` that falls in the `220-246` ZIP3 range. The test catalog seed must have `common_name = 'Tomato'` and `sow_method = 'transplant'` so it matches the bundled `VA,tomato,transplant` entry.

```typescript
// Check 10: an extension-covered seed reports source 'extension'.
{
  const res = await fetch(`${BASE}/api/recommendations/${extCatalogSeedId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  check(10, 'extension-covered seed has source=extension',
    res.status === 200 && body.data.source === 'extension'
    && body.data.recommendedRange?.start?.endsWith('-05-05'));
}

// Check 11: changing a calendar entry invalidates the region's cache.
{
  await sql`UPDATE extension_calendar_entries
               SET window_start = '05-12'
             WHERE region_id = 'VA' AND crop_key = 'tomato' AND sow_method = 'transplant'`;
  const cached = await sql`SELECT 1 FROM recommendation_cache
                            WHERE catalog_seed_id = ${extCatalogSeedId}`;
  check(11, 'calendar change cleared the region cache', cached.length === 0);
  // restore
  await sql`UPDATE extension_calendar_entries
               SET window_start = '05-05'
             WHERE region_id = 'VA' AND crop_key = 'tomato' AND sow_method = 'transplant'`;
}
```

Adapt `extCatalogSeedId`, `token`, `BASE`, `sql`, and `check(...)` to the script's existing names and helpers. Create the `extCatalogSeedId` fixture (a published `catalog_seeds` row, `common_name = 'Tomato'`, `sow_method = 'transplant'`) in the setup block alongside the existing catalog fixture, and delete it in the cleanup block.

- [ ] **Step 3: Run the smoke script**

Prerequisites: local Postgres migrated through 0009, `bun run seed:zip` and `bun run seed:calendars` both run, dev server up (`bun run dev`).

Run: `cd ~/git/seedkeep-server && bun run scripts/recommendations-smoke.ts`
Expected: all checks 1-11 PASS.

- [ ] **Step 4: Commit**

```bash
cd ~/git/seedkeep-server
git add scripts/recommendations-smoke.ts
git commit -m "Smoke-test the extension-calendar recommendation path"
```

---

## Done — Phase A complete

After Task 10, Phase A is implemented and verified locally. Deployment (the `fly deploy` + `seed:calendars` on Fly) and Phase B (the `seedkeep-ios` `sourceAttribution` DTO field + `RecommendationPanel` credit line) are separate follow-ups — Phase B gets its own plan written against the deployed API.

**Spec coverage:** migration 0009 (Task 1) · region model + resolution (Tasks 2, 7) · crop matching (Tasks 3, 8) · extension baseline + source precedence (Tasks 4, 8, 9) · bundled dataset + seed script (Tasks 5, 6) · cache invalidation trigger (Task 1) · testing (Tasks 2-4 units, Task 10 smoke). The community submission/moderation pipeline is intentionally out of scope (schema is community-ready; pipeline is the fast-follow).
