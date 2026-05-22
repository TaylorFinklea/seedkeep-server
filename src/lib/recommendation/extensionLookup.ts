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
