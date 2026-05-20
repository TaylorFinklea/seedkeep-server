/**
 * Build script: ZIP location dataset
 *
 * Joins three public datasets on 5-digit ZIP code and writes
 * data/zip_locations.csv with columns:
 *   zip,latitude,longitude,usda_zone,avg_last_frost,avg_first_frost
 *
 * Sources:
 *   - USDA Plant Hardiness Zone Map (2023) via phzmapi.org S3 (public)
 *   - US Census ZCTA Gazetteer 2024 (lat/lon fallback)
 *   - NOAA frost climatology: zone→frost fallback (see ZONE_FROST_FALLBACK)
 *
 * Run: bun run scripts/build-zip-dataset.ts
 */

import { join } from 'path';

const DATA_DIR = join(import.meta.dir, '..', 'data');
const SOURCES_DIR = join(DATA_DIR, 'sources');
const OUTPUT_CSV = join(DATA_DIR, 'zip_locations.csv');
const GAZETTEER_FILE = join(SOURCES_DIR, '2024_Gaz_zcta_national.txt');

// USDA zone → approximate frost dates derived from NOAA historical climatology.
// Sources: NOAA Climate Normals (1991-2020), USDA zone boundaries.
// Zones 1-2 and 12-13 have negligible US population; mapped to nearest defined zone.
const ZONE_FROST_FALLBACK: Record<string, { lastFrost: string; firstFrost: string }> = {
  '1a': { lastFrost: '06-15', firstFrost: '08-15' },
  '1b': { lastFrost: '06-10', firstFrost: '08-20' },
  '2a': { lastFrost: '06-08', firstFrost: '08-25' },
  '2b': { lastFrost: '06-05', firstFrost: '08-28' },
  '3a': { lastFrost: '06-01', firstFrost: '09-01' },
  '3b': { lastFrost: '05-25', firstFrost: '09-08' },
  '4a': { lastFrost: '05-20', firstFrost: '09-15' },
  '4b': { lastFrost: '05-15', firstFrost: '09-22' },
  '5a': { lastFrost: '05-10', firstFrost: '10-01' },
  '5b': { lastFrost: '05-01', firstFrost: '10-08' },
  '6a': { lastFrost: '04-25', firstFrost: '10-15' },
  '6b': { lastFrost: '04-15', firstFrost: '10-22' },
  '7a': { lastFrost: '04-10', firstFrost: '11-01' },
  '7b': { lastFrost: '04-01', firstFrost: '11-08' },
  '8a': { lastFrost: '03-20', firstFrost: '11-15' },
  '8b': { lastFrost: '03-10', firstFrost: '11-25' },
  '9a': { lastFrost: '02-20', firstFrost: '12-10' },
  '9b': { lastFrost: '02-01', firstFrost: '12-20' },
  '10a': { lastFrost: '01-20', firstFrost: '12-31' },
  '10b': { lastFrost: '01-10', firstFrost: '12-31' },
  '11a': { lastFrost: '01-01', firstFrost: '12-31' },
  '11b': { lastFrost: '01-01', firstFrost: '12-31' },
  '12a': { lastFrost: '01-01', firstFrost: '12-31' },
  '12b': { lastFrost: '01-01', firstFrost: '12-31' },
  '13a': { lastFrost: '01-01', firstFrost: '12-31' },
  '13b': { lastFrost: '01-01', firstFrost: '12-31' },
};

interface PhzmRow {
  zone: string;
  lat: number;
  lon: number;
}

interface GazetteerRow {
  zip: string;
  lat: number;
  lon: number;
}

interface OutputRow {
  zip: string;
  latitude: number;
  longitude: number;
  usda_zone: string;
  avg_last_frost: string;
  avg_first_frost: string;
}

// Parse the Census ZCTA Gazetteer (tab-delimited, header row)
async function loadGazetteer(): Promise<Map<string, GazetteerRow>> {
  const text = await Bun.file(GAZETTEER_FILE).text();
  const lines = text.trim().split('\n');
  const map = new Map<string, GazetteerRow>();

  // Header: GEOID  ALAND  AWATER  ALAND_SQMI  AWATER_SQMI  INTPTLAT  INTPTLONG
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length < 7) continue;
    const zip = cols[0].trim().padStart(5, '0');
    const lat = parseFloat(cols[5].trim());
    const lon = parseFloat(cols[6].trim());
    if (!isNaN(lat) && !isNaN(lon)) {
      map.set(zip, { zip, lat, lon });
    }
  }
  return map;
}

// Fetch a single ZIP from phzmapi.org S3
async function fetchZone(zip: string): Promise<PhzmRow | null> {
  try {
    const resp = await fetch(`https://phzmapi.org/${zip}.json`, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) return null;
    const data = await resp.json() as {
      zone: string;
      coordinates?: { lat: string; lon: string };
    };
    if (!data.zone) return null;
    return {
      zone: data.zone.trim().toLowerCase(),
      lat: data.coordinates ? parseFloat(data.coordinates.lat) : NaN,
      lon: data.coordinates ? parseFloat(data.coordinates.lon) : NaN,
    };
  } catch {
    return null;
  }
}

// Batch-fetch zones with concurrency limit
async function fetchAllZones(zips: string[], concurrency = 80): Promise<Map<string, PhzmRow>> {
  const results = new Map<string, PhzmRow>();
  let done = 0;
  const total = zips.length;

  // Process in batches
  for (let i = 0; i < total; i += concurrency) {
    const batch = zips.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      batch.map(async (zip) => {
        const row = await fetchZone(zip);
        return { zip, row };
      })
    );
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value.row) {
        results.set(result.value.zip, result.value.row);
      }
    }
    done += batch.length;
    if (done % 2000 === 0 || done === total) {
      console.log(`  Fetched zones: ${done}/${total} (${results.size} hits)`);
    }
  }
  return results;
}

// Main
async function main() {
  console.log('Building ZIP location dataset...\n');

  // Step 1: Load Census gazetteer
  console.log('Loading Census ZCTA Gazetteer...');
  const gazetteer = await loadGazetteer();
  console.log(`  Gazetteer ZIPs: ${gazetteer.size}`);

  // Step 2: Fetch USDA zones from phzmapi.org for all gazetteer ZIPs
  const allZips = Array.from(gazetteer.keys()).sort();
  console.log(`\nFetching USDA hardiness zones for ${allZips.length} ZIPs from phzmapi.org...`);
  console.log('(This may take 2-5 minutes with 80 concurrent requests)\n');

  const zoneMap = await fetchAllZones(allZips, 80);
  console.log(`\n  Zone hits: ${zoneMap.size}/${allZips.length}`);

  // Step 3: Build output rows
  const rows: OutputRow[] = [];
  let skipped = 0;
  let frostFallbackCount = 0;

  for (const zip of allZips) {
    const gaz = gazetteer.get(zip)!;
    const zoneData = zoneMap.get(zip);

    if (!zoneData) {
      skipped++;
      continue;
    }

    // Prefer phzmapi coordinates; fall back to gazetteer centroid
    const lat = !isNaN(zoneData.lat) ? zoneData.lat : gaz.lat;
    const lon = !isNaN(zoneData.lon) ? zoneData.lon : gaz.lon;

    if (isNaN(lat) || isNaN(lon)) {
      skipped++;
      continue;
    }

    // Frost dates: always from zone fallback (no per-ZIP NOAA data)
    const frost = ZONE_FROST_FALLBACK[zoneData.zone];
    if (!frost) {
      // Unknown zone — skip
      skipped++;
      continue;
    }
    frostFallbackCount++;

    rows.push({
      zip,
      latitude: parseFloat(lat.toFixed(5)),
      longitude: parseFloat(lon.toFixed(5)),
      usda_zone: zoneData.zone,
      avg_last_frost: frost.lastFrost,
      avg_first_frost: frost.firstFrost,
    });
  }

  // Stats
  console.log('\n--- Stats ---');
  console.log(`  Total ZIPs in gazetteer:       ${allZips.length}`);
  console.log(`  Zone hits from phzmapi:        ${zoneMap.size}`);
  console.log(`  Output rows:                   ${rows.length}`);
  console.log(`  Zone fallback for frost dates: ${frostFallbackCount} (all rows)`);
  console.log(`  Skipped (no zone or bad data): ${skipped}`);

  // Step 4: Write CSV
  const header = 'zip,latitude,longitude,usda_zone,avg_last_frost,avg_first_frost';
  const csvLines = [header, ...rows.map(r =>
    `${r.zip},${r.latitude},${r.longitude},${r.usda_zone},${r.avg_last_frost},${r.avg_first_frost}`
  )];
  const csv = csvLines.join('\n') + '\n';

  await Bun.write(OUTPUT_CSV, csv);
  console.log(`\nWrote ${rows.length} rows to ${OUTPUT_CSV}`);

  // Step 5: Spot-checks
  console.log('\n--- Spot checks ---');
  const spotZips = ['10001', '90001', '99501'];
  for (const z of spotZips) {
    const row = rows.find(r => r.zip === z);
    if (row) {
      console.log(`  ${z}: lat=${row.latitude}, lon=${row.longitude}, zone=${row.usda_zone}, last_frost=${row.avg_last_frost}, first_frost=${row.avg_first_frost}`);
    } else {
      console.log(`  ${z}: NOT FOUND`);
    }
  }

  if (rows.length < 30_000) {
    console.error(`\nWARNING: Row count ${rows.length} is below the expected minimum of 30,000`);
    process.exit(1);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
