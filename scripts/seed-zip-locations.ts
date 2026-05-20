/**
 * Seed script — loads data/zip_locations.csv into the zip_locations table.
 *
 * Runs in batches of 1,000 rows and upserts on conflict so re-running is
 * idempotent. Run with: bun run seed:zip
 */

import { loadEnv } from '../src/env';
import { getSql, closeDb } from '../src/db/client';
import { dbBatch } from '../src/db/helpers';
import { readFileSync } from 'fs';
import { join } from 'path';

async function main() {
  const env = loadEnv();
  const sql = getSql(env);

  const csvPath = join(import.meta.dir, '..', 'data', 'zip_locations.csv');
  const content = readFileSync(csvPath, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);

  // Skip header row
  const dataLines = lines.slice(1);
  console.log(`Parsed ${dataLines.length} rows from CSV`);

  const BATCH_SIZE = 1000;
  let totalUpserted = 0;

  for (let i = 0; i < dataLines.length; i += BATCH_SIZE) {
    const batch = dataLines.slice(i, i + BATCH_SIZE);

    const statements = batch.map((line) => {
      const [zip, latitude, longitude, usda_zone, avg_last_frost, avg_first_frost] = line.split(',');
      return {
        sql: `
          INSERT INTO zip_locations (zip, latitude, longitude, usda_zone, avg_last_frost, avg_first_frost)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (zip) DO UPDATE SET
            latitude        = EXCLUDED.latitude,
            longitude       = EXCLUDED.longitude,
            usda_zone       = EXCLUDED.usda_zone,
            avg_last_frost  = EXCLUDED.avg_last_frost,
            avg_first_frost = EXCLUDED.avg_first_frost
        `,
        params: [zip, Number(latitude), Number(longitude), usda_zone, avg_last_frost, avg_first_frost],
      };
    });

    await dbBatch(sql, statements);
    totalUpserted += batch.length;
    console.log(`  upserted ${totalUpserted} / ${dataLines.length}`);
  }

  console.log(`Done — ${totalUpserted} rows upserted into zip_locations`);

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
