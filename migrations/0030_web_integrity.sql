-- Web M1 Phase 3 — garden data integrity (spec: .docs/ai/plans/web-m1-p3-integrity.md).
--
-- 1. Optimistic-concurrency `version` on mutable garden rows. Existing rows
--    start at 1; routes increment it on every write.
-- 2. `seeds.custom_type` for user-entered seed types (web Type column).
-- 3. Household-consistent references: (id, household_id) uniqueness on parent
--    tables plus composite foreign keys so a row can only reference parents
--    in its own household. Added NOT VALID so legacy rows are not rechecked;
--    new writes are enforced. Nullable references use SET NULL (column) so
--    household_id is never nulled (PostgreSQL 15+).
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS and constraint-existence checks.
--
-- Locking: garden tables are small (internal testers only), so the runner's
-- single transaction is acceptable; lock_timeout makes the migration fail
-- fast instead of queueing behind live traffic. Retry the deploy if it hits.

SET LOCAL lock_timeout = '5s';

ALTER TABLE seeds                   ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE locations               ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE tags                    ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE beds                    ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE planting_events         ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE journal_entries         ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE journal_checklist_items ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;

ALTER TABLE seeds ADD COLUMN IF NOT EXISTS custom_type TEXT;

DO $$
DECLARE
  spec TEXT[];
  specs TEXT[][] := ARRAY[
    -- name, table, definition
    ARRAY['locations_id_household_uq',       'locations',       'UNIQUE (id, household_id)'],
    ARRAY['tags_id_household_uq',            'tags',            'UNIQUE (id, household_id)'],
    ARRAY['beds_id_household_uq',            'beds',            'UNIQUE (id, household_id)'],
    ARRAY['seeds_id_household_uq',           'seeds',           'UNIQUE (id, household_id)'],
    ARRAY['planting_events_id_household_uq', 'planting_events', 'UNIQUE (id, household_id)'],
    ARRAY['journal_entries_id_household_uq', 'journal_entries', 'UNIQUE (id, household_id)'],
    ARRAY['seeds_location_household_fk', 'seeds',
      'FOREIGN KEY (location_id, household_id) REFERENCES locations(id, household_id) ON DELETE SET NULL (location_id) NOT VALID'],
    ARRAY['seed_tags_tag_household_fk', 'seed_tags',
      'FOREIGN KEY (tag_id, household_id) REFERENCES tags(id, household_id) ON DELETE CASCADE NOT VALID'],
    ARRAY['seed_tags_seed_household_fk', 'seed_tags',
      'FOREIGN KEY (seed_id, household_id) REFERENCES seeds(id, household_id) ON DELETE CASCADE NOT VALID'],
    ARRAY['planting_events_bed_household_fk', 'planting_events',
      'FOREIGN KEY (bed_id, household_id) REFERENCES beds(id, household_id) ON DELETE SET NULL (bed_id) NOT VALID'],
    ARRAY['planting_events_seed_household_fk', 'planting_events',
      'FOREIGN KEY (seed_id, household_id) REFERENCES seeds(id, household_id) ON DELETE SET NULL (seed_id) NOT VALID'],
    ARRAY['journal_entries_seed_household_fk', 'journal_entries',
      'FOREIGN KEY (seed_id, household_id) REFERENCES seeds(id, household_id) ON DELETE CASCADE NOT VALID'],
    ARRAY['journal_entries_bed_household_fk', 'journal_entries',
      'FOREIGN KEY (bed_id, household_id) REFERENCES beds(id, household_id) ON DELETE CASCADE NOT VALID'],
    ARRAY['journal_entries_event_household_fk', 'journal_entries',
      'FOREIGN KEY (planting_event_id, household_id) REFERENCES planting_events(id, household_id) ON DELETE CASCADE NOT VALID'],
    ARRAY['journal_entry_photos_entry_household_fk', 'journal_entry_photos',
      'FOREIGN KEY (entry_id, household_id) REFERENCES journal_entries(id, household_id) ON DELETE CASCADE NOT VALID'],
    ARRAY['seed_photos_seed_household_fk', 'seed_photos',
      'FOREIGN KEY (seed_id, household_id) REFERENCES seeds(id, household_id) ON DELETE CASCADE NOT VALID']
  ];
BEGIN
  FOREACH spec SLICE 1 IN ARRAY specs LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = spec[1]) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', spec[2], spec[1], spec[3]);
    END IF;
  END LOOP;
END $$;

-- Validate the composite foreign keys when legacy data is already consistent.
-- A violating legacy row leaves that constraint NOT VALID (still enforced for
-- new writes) and raises a NOTICE for follow-up remediation.
DO $$
DECLARE
  fk TEXT[];
  fks TEXT[][] := ARRAY[
    ARRAY['seeds', 'seeds_location_household_fk'],
    ARRAY['seed_tags', 'seed_tags_tag_household_fk'],
    ARRAY['seed_tags', 'seed_tags_seed_household_fk'],
    ARRAY['planting_events', 'planting_events_bed_household_fk'],
    ARRAY['planting_events', 'planting_events_seed_household_fk'],
    ARRAY['journal_entries', 'journal_entries_seed_household_fk'],
    ARRAY['journal_entries', 'journal_entries_bed_household_fk'],
    ARRAY['journal_entries', 'journal_entries_event_household_fk'],
    ARRAY['journal_entry_photos', 'journal_entry_photos_entry_household_fk'],
    ARRAY['seed_photos', 'seed_photos_seed_household_fk']
  ];
BEGIN
  FOREACH fk SLICE 1 IN ARRAY fks LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', fk[1], fk[2]);
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE NOTICE 'web_integrity: % on % left NOT VALID (legacy cross-household rows)', fk[2], fk[1];
    END;
  END LOOP;
END $$;
