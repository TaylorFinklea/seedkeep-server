// Loads the bundled extension-calendar dataset (data/regions.csv,
// data/crop_aliases.csv, data/extension_calendars.csv) into Postgres.
// Validates every row; aborts on the first malformed row. Idempotent.
// Run: bun run seed:calendars

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { getSql, closeDb } from '../src/db/client';
import { dbBatch } from '../src/db/helpers';
import { loadEnv } from '../src/env';

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
  const env = loadEnv();
  const sql = getSql(env);
  const now = Date.now();

  // --- regions ---
  const regionRows = readCsv('regions.csv');
  const regionStmts = regionRows.map(([id, displayName, stateCode], i) => {
    if (!id || !displayName || !stateCode) fail('regions.csv', i, 'empty field');
    return {
      sql: `INSERT INTO regions (id, display_name, state_code, created_at)
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
      sql: `INSERT INTO crop_aliases (alias, crop_key) VALUES ($1, $2)
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
      sql: `INSERT INTO extension_calendar_entries
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
