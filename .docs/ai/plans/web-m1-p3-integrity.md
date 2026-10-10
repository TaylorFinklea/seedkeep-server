# Web M1 · Phase 3 — Garden data integrity

Umbrella plan: `~/git/seedkeep/.docs/ai/phases/2026-10-09-web-app-plan.md`.
Branch: `web/m1-p3-integrity`, based on `web/m1-p2-sessions`.

Goal: the household routes become a safe API for concurrent web clients.
- Writes are field-selective and atomic.
- Optimistic concurrency uses versions, so lost updates are detected rather
  than silent.
- Deletes and cascades are transactional.
- References are household-consistent, and child rows accept client ids.

Old iOS builds that send no version keep today's last-write-wins behaviour.

Absorbs the roadmap items `seedkeep-67y` (atomic, field-selective PATCH),
`seedkeep-8pw` (transactional deletion) and `seedkeep-dk4` (household
foreign keys).

## Contract (parent-owned)

### Migration `migrations/0030_web_integrity.sql`
- A `version BIGINT NOT NULL DEFAULT 1` column on seeds, locations, tags,
  beds, planting_events, journal_entries and journal_checklist_items.
- A `custom_type TEXT` column on seeds (≤ 80 characters, validated in the
  app).
- **Household-consistent references:**
  - `UNIQUE (id, household_id)` on locations, tags, beds, seeds,
    planting_events and journal_entries.
  - Composite foreign keys, added `NOT VALID` so legacy rows are not
    rechecked:
    - seeds(location_id, household_id) → locations
    - seed_tags(tag_id, household_id) → tags
    - seed_tags(seed_id, household_id) → seeds
    - planting_events(bed_id, household_id) → beds
    - planting_events(seed_id, household_id) → seeds
    - journal_entries(seed_id | bed_id | planting_event_id, household_id) →
      their parents
  - Nullable columns use `MATCH SIMPLE`, so a NULL reference is allowed.
- Re-runnable: `IF NOT EXISTS`, plus constraint existence checks in DO
  blocks.

### Helper `src/lib/versioning.ts` (implemented by the parent)
- `expectedVersion(c): number | null | 'invalid'` parses `If-Match: "<n>"`
  or `If-Match: <n>`. An absent header gives null; a malformed one gives
  'invalid', which routes answer with `invalidIfMatch(c)` (400).
- `setVersionHeader(c, version)` sets `ETag: "<n>"`.
- `versionConflict(c, current)` returns 409 with
  `{ ok:false, error:{ code:'version_conflict', message }, data:{ current } }`.
  Here `current` is the row in the route's normal response shape, or null
  when the row was deleted.

### Wire contract for every garden write
- Every row in responses and delta feeds includes `version` (as a number).
- **Create:**
  - The optional client `id` (1–80 characters) is now also accepted for
    journal entries, journal checklist items, seed photos and journal
    photos.
  - A duplicate id inside the caller's household replays the stored row
    (200, the same shape).
  - A duplicate id in another household → 409 `conflict`, without revealing
    the other row.
  - New rows start at version 1.
- **PATCH:**
  - Field-selective. A single `UPDATE … SET <only the provided columns>,
    version = version + 1, updated_at = $now WHERE id AND household_id AND
    deleted_at IS NULL [AND version = $expected] RETURNING *`. There is no
    read-merge-write.
  - Relational parts change in the same transaction, for example a seed's
    `tag_ids` replacement.
  - With If-Match and no matching row:
    - the row is missing or deleted → 404 `not_found`
    - the version differs → 409 `version_conflict` with the current row
  - The response carries the new row and an `ETag`.
- **DELETE:**
  - One transaction covers the tombstone, version + 1 and the documented
    cascades: seed → events, journal entries; bed → events; event → its
    journal entries; journal entry → checklist items and photos.
  - Photo object deletes run best-effort after commit.
  - If-Match is honoured the same way as PATCH.
  - Repeating a delete of an already-tombstoned row → 404, as today.
- **Child changes bump the parent:**
  - Creating, updating or deleting a checklist item, or adding or removing a
    journal photo, increments the parent journal entry's version and
    `updated_at` in the same transaction, so delta feeds surface it.
  - Seed photo changes do the same for the seed.
- **References:**
  - A reference to a row in another household, or one that doesn't exist →
    400 `invalid_reference`. The pre-check runs in the transaction, so the
    composite foreign keys are a backstop.
  - Never reveal whether the id exists elsewhere.
- **`custom_type`:** accepted on seed create and PATCH, and returned
  everywhere.

## Concurrency, cascades and scope (added after the Sol contract review)

- **Parent locking.** A write that creates or re-points a child row locks
  every referenced active parent with `SELECT … FOR SHARE` in the same
  transaction, and fails 400 `invalid_reference` if the parent is missing,
  deleted, or in another household. A parent DELETE locks its own row
  `FOR UPDATE` first. Lock order is always parent before child, so a
  concurrent soft delete and a child create serialize.
- **Cascade closure, all in one transaction, each affected row gets
  `version + 1`, `updated_at = now`, `deleted_at = now`:**
  - **seed** → its planting events → journal entries attached to those
    events; plus journal entries attached directly to the seed.
  - **bed** → its planting events → their journal entries; plus journal
    entries attached directly to the bed.
  - **planting event** → its journal entries.
  - **journal entry** → its checklist items are hard-deleted and its photo
    rows are hard-deleted (objects removed best-effort after commit). The
    entry's own tombstone version is the change signal.
  - **location delete** clears `location_id` on its seeds (bump each seed).
    **Tag delete** removes the `seed_tags` rows (bump each affected seed).
- **Every persisted mutation bumps versions**, including writes made by the
  assistant tool executor (`src/lib/assistant/**`) to these tables. Luna
  owns executor compatibility.
- **Household-scoped reads.** `TAG_IDS_AGG` and the journal photo and
  checklist listings filter by `household_id`.
- **Photos are immutable.** They have no version column. Create and delete
  bump the parent once, and a replay of an existing client id returns the
  stored row without another bump. Raw-byte uploads take the client id from
  the `?id=<1–80 chars>` query parameter. Photo DELETE ignores If-Match.
- **Planting-event create side effects.** Creating an event also creates its
  journal entry and checklist rows. Those rows start at version 1. Replaying
  the create (same client id) must not create a second journal or checklist
  pair.
- **Helpers.** `dbGet`, `dbAll` and `dbRun` accept `Queryable`
  (`Sql | TransactionSql`). Use `sql.begin(async (tx) => …)` callbacks and
  throw to roll back. Don't use `dbBatch` for conditional cascades.
- **Delta feeds are out of scope.** The cursor ordering (`updated_at`,
  `since_id`) can miss same-millisecond or late-committed rows. This is a
  pre-existing limitation, and the web client does not rely on deltas: it
  refetches the baseline (`since=0`) on load, on focus and on an interval,
  and uses versions only for writes. Feeds still include `version`.
  Documented; no change.

## File ownership

| Files | Owner |
|---|---|
| migration 0030, `src/lib/versioning.ts`, this doc | Parent |
| `src/routes/seeds.ts`, `src/routes/planting-events.ts`, `src/routes/journal.ts`, `src/routes/photos.ts`, `src/lib/sync.ts` (if feeds need `version`), `src/lib/assistant/**` (version bumps on garden writes only), unit tests for these, `tests/integration/versionedWritesJourney.test.ts` (seeds, events, journal, checklist, photos, cascades from seeds and events, create-versus-delete races, replay after update and after delete, event-create replay producing exactly one journal and checklist pair, photo client ids) | **Luna** |
| `src/routes/locations.ts`, `src/routes/tags.ts`, `src/routes/beds.ts` (including the full bed cascade, and the seed version bumps caused by location and tag deletes), unit tests for these, `tests/integration/versionedSimpleRoutes.test.ts` (locations, tags, beds, cross-household references, bed → events → journal cascade, location and tag deletes bumping seeds) | **Haiku** |
| `migrations/0030_web_integrity.sql` test: `tests/integration/migration0030.test.ts` (re-runnable; validates on clean data; leaves NOT VALID with legacy violators) | **Haiku** |

## Tests

For every touched route:
- version increments
- If-Match match and mismatch, giving 409 with the current row
- a malformed If-Match → 400
- no If-Match → succeeds (legacy)
- concurrent PATCHes with the same expected version: exactly one succeeds
- field-selective: a PATCH of `notes` doesn't clobber a concurrent PATCH of
  `state`
- delete-cascade atomicity: if a forced failure happens mid-cascade,
  nothing changes
- cross-household reference → 400
- client-id replay → 200, and a foreign-household duplicate → 409
- delta feeds include `version`, and child changes surface through the
  parent

The existing suites must stay green: 322 unit plus the integration suites,
including the Phase 2 web session journey.
