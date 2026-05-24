import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { getSql } from '../db/client';
import { dbGet, dbRun } from '../db/helpers';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { computeRuleBaseline, CONFIDENCE_THRESHOLD } from '../lib/recommendation/engine';
import type { CatalogHorticultural, HouseholdLocation } from '../lib/recommendation/engine';
import { fetchAiBaseline } from '../lib/recommendation/aiFallback';
import { projectWindow } from '../lib/recommendation/projection';
import { locationSignature } from '../lib/recommendation/locationSignature';
import { lookupExtensionEntry } from '../lib/recommendation/extensionLookup';
import { resolveExtensionBaseline } from '../lib/recommendation/extensionBaseline';
import { zipToRegion } from '../lib/recommendation/region';

export const recommendationRoutes = new Hono<AppEnv>();
const auth = [requireAuth(), requireHousehold()] as const;

interface HouseholdLocationRow {
  home_zip: string | null;
  latitude: number | null;
  longitude: number | null;
  usda_zone: string | null;
  avg_last_frost: string | null;
  avg_first_frost: string | null;
  region_id: string | null;
}

interface CatalogRow extends CatalogHorticultural {
  id: string;
  common_name: string;
  variety: string | null;
  instructions: string | null;
}

interface CacheRow {
  source: 'rule' | 'ai' | 'extension';
  confidence: number;
  window_start: string | null;
  window_end: string | null;
  indoor_start: string | null;
  indoor_end: string | null;
  reasoning: string | null;
  inputs_used: string;
  computed_at: number;
}

const CATALOG_HORT_SELECT = `id, common_name, variety, instructions,
  frost_tolerance, sow_method, soil_temp_min_f, soil_temp_max_f,
  days_to_germinate_min, days_to_germinate_max,
  days_to_maturity_min, days_to_maturity_max,
  hardiness_zone_min, hardiness_zone_max`;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

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

function assembleRecommendation(
  catalogSeedId: string,
  signature: string,
  cache: CacheRow,
) {
  const proj = projectWindow(
    { windowStart: cache.window_start, windowEnd: cache.window_end },
    todayStr(),
  );
  return {
    catalogSeedId,
    locationSignature: signature,
    computedAt: cache.computed_at,
    source: cache.source,
    confidence: cache.confidence,
    verdict: proj.verdict,
    recommendedRange: cache.window_start && cache.window_end
      ? { start: cache.window_start, end: cache.window_end } : null,
    indoorRange: cache.indoor_start && cache.indoor_end
      ? { start: cache.indoor_start, end: cache.indoor_end } : null,
    dailyScores: proj.dailyScores,
    reasoning: cache.reasoning,
    inputsUsed: JSON.parse(cache.inputs_used) as string[],
  };
}

async function loadLocation(sql: ReturnType<typeof getSql>, householdId: string)
  : Promise<(HouseholdLocation & { latitude: number; longitude: number; regionId: string | null }) | null> {
  const row = await dbGet<HouseholdLocationRow>(
    sql,
    `SELECT home_zip, latitude, longitude, usda_zone, avg_last_frost, avg_first_frost, region_id
       FROM households WHERE id = $1 LIMIT 1`,
    [householdId],
  );
  if (!row || row.usda_zone == null || row.avg_last_frost == null ||
      row.avg_first_frost == null || row.latitude == null || row.longitude == null) {
    return null;
  }

  // Self-heal: migration 0009 added region_id but didn't backfill for
  // households whose location was set pre-extension. If region_id is null
  // but home_zip is known, derive + persist on read so this household's
  // next request (and every cached row it ever writes) is region-aware.
  // The UPDATE fires the household-change trigger and wipes any stale
  // cache rows for the household's zone, so the next read does a fresh
  // compute through extension lookup. Idempotent: a backfilled household
  // skips this branch entirely on subsequent loads.
  let regionId = row.region_id;
  if (!regionId && row.home_zip) {
    regionId = zipToRegion(row.home_zip);
    if (regionId) {
      await dbRun(
        sql,
        `UPDATE households SET region_id = $1 WHERE id = $2 AND region_id IS NULL`,
        [regionId, householdId],
      );
    }
  }

  return {
    usdaZone: row.usda_zone,
    avgLastFrost: row.avg_last_frost,
    avgFirstFrost: row.avg_first_frost,
    latitude: row.latitude,
    longitude: row.longitude,
    regionId,
  };
}

async function readCache(sql: ReturnType<typeof getSql>, catalogSeedId: string, signature: string)
  : Promise<CacheRow | null> {
  return dbGet<CacheRow>(
    sql,
    `SELECT source, confidence, window_start, window_end, indoor_start, indoor_end,
            reasoning, inputs_used, computed_at
       FROM recommendation_cache
      WHERE catalog_seed_id = $1 AND location_signature = $2 LIMIT 1`,
    [catalogSeedId, signature],
  );
}

async function writeCache(
  sql: ReturnType<typeof getSql>,
  catalogSeedId: string, signature: string,
  source: 'rule' | 'ai' | 'extension', confidence: number,
  base: { windowStart: string | null; windowEnd: string | null;
          indoorStart: string | null; indoorEnd: string | null },
  reasoning: string | null, inputsUsed: string[],
  regionId: string | null,
): Promise<CacheRow> {
  const computedAt = Date.now();
  await dbRun(
    sql,
    `INSERT INTO recommendation_cache
       (catalog_seed_id, location_signature, region_id, computed_at, source, confidence,
        window_start, window_end, indoor_start, indoor_end, reasoning, inputs_used)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (catalog_seed_id, location_signature) DO UPDATE SET
       region_id = EXCLUDED.region_id, computed_at = EXCLUDED.computed_at,
       source = EXCLUDED.source, confidence = EXCLUDED.confidence,
       window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end,
       indoor_start = EXCLUDED.indoor_start, indoor_end = EXCLUDED.indoor_end,
       reasoning = EXCLUDED.reasoning, inputs_used = EXCLUDED.inputs_used`,
    [catalogSeedId, signature, regionId, computedAt, source, confidence,
     base.windowStart, base.windowEnd, base.indoorStart, base.indoorEnd,
     reasoning, JSON.stringify(inputsUsed)],
  );
  return {
    source, confidence,
    window_start: base.windowStart, window_end: base.windowEnd,
    indoor_start: base.indoorStart, indoor_end: base.indoorEnd,
    reasoning, inputs_used: JSON.stringify(inputsUsed), computed_at: computedAt,
  };
}

recommendationRoutes.get('/recommendations/:catalogSeedId', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const sql = getSql(c.env);
  const catalogSeedId = c.req.param('catalogSeedId');

  const loc = await loadLocation(sql, householdId);
  if (!loc) {
    return c.json({ ok: false, error: { code: 'no_household_location',
      message: 'Set a home ZIP to get planting recommendations' } }, 409);
  }

  const cat = await dbGet<CatalogRow>(
    sql, `SELECT ${CATALOG_HORT_SELECT} FROM catalog_seeds WHERE id = $1 LIMIT 1`,
    [catalogSeedId],
  );
  if (!cat) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Catalog seed not found' } }, 404);
  }

  const signature = locationSignature(loc.usdaZone, loc.latitude, loc.longitude, loc.regionId);
  let cache = await readCache(sql, catalogSeedId, signature);

  if (!cache) {
    const year = new Date().getUTCFullYear();

    // Extension calendar takes priority over the rule engine.
    const ext = await tryExtensionBaseline(
      sql, loc.regionId, cat.common_name, cat.sow_method, year,
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
        [catalogSeedId, signature, loc.regionId, Date.now(),
         ext.confidence, ext.windowStart, ext.windowEnd, ext.indoorStart,
         ext.indoorEnd, ext.reasoning, JSON.stringify(['extension_calendar'])],
      );
      const extCache: CacheRow = {
        source: 'extension',
        confidence: ext.confidence,
        window_start: ext.windowStart,
        window_end: ext.windowEnd,
        indoor_start: ext.indoorStart,
        indoor_end: ext.indoorEnd,
        reasoning: ext.reasoning,
        inputs_used: JSON.stringify(['extension_calendar']),
        computed_at: Date.now(),
      };
      return c.json({ ok: true, data: assembleRecommendation(catalogSeedId, signature, extCache) });
    }

    const ruleBase = computeRuleBaseline(cat, loc, year);
    if (ruleBase.confidence >= CONFIDENCE_THRESHOLD) {
      cache = await writeCache(sql, catalogSeedId, signature, 'rule',
        ruleBase.confidence, ruleBase, null, ruleBase.inputsUsed, loc.regionId);
    } else {
      const apiKey = c.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        try {
          const ai = await fetchAiBaseline(apiKey, c.env.DEFAULT_REVIEW_MODEL,
            { commonName: cat.common_name, variety: cat.variety, instructions: cat.instructions },
            loc, year);
          if (ai) {
            cache = await writeCache(sql, catalogSeedId, signature, 'ai',
              ai.confidence, ai, ai.reasoning, ['ai_fallback'], loc.regionId);
          }
        } catch {
          // fall through to the rule baseline below
        }
      }
      if (!cache) {
        cache = await writeCache(sql, catalogSeedId, signature, 'rule',
          ruleBase.confidence, ruleBase, null, ruleBase.inputsUsed, loc.regionId);
      }
    }
  }

  return c.json({ ok: true, data: assembleRecommendation(catalogSeedId, signature, cache) });
});

recommendationRoutes.post('/recommendations/bulk', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const sql = getSql(c.env);

  const body = await c.req.json().catch(() => null) as { catalogSeedIds?: unknown } | null;
  const ids = Array.isArray(body?.catalogSeedIds)
    ? (body!.catalogSeedIds as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 200)
    : [];

  const loc = await loadLocation(sql, householdId);
  if (!loc) {
    return c.json({ ok: false, error: { code: 'no_household_location',
      message: 'Set a home ZIP to get planting recommendations' } }, 409);
  }

  const signature = locationSignature(loc.usdaZone, loc.latitude, loc.longitude, loc.regionId);
  const year = new Date().getUTCFullYear();
  const recommendations: unknown[] = [];
  const pending: string[] = [];

  for (const id of ids) {
    let cache = await readCache(sql, id, signature);
    if (!cache) {
      const cat = await dbGet<CatalogRow>(
        sql, `SELECT ${CATALOG_HORT_SELECT} FROM catalog_seeds WHERE id = $1 LIMIT 1`, [id],
      );
      if (!cat) continue;

      // Extension calendar takes priority over the rule engine.
      const ext = await tryExtensionBaseline(
        sql, loc.regionId, cat.common_name, cat.sow_method, year,
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
          [id, signature, loc.regionId, Date.now(),
           ext.confidence, ext.windowStart, ext.windowEnd, ext.indoorStart,
           ext.indoorEnd, ext.reasoning, JSON.stringify(['extension_calendar'])],
        );
        const extCache: CacheRow = {
          source: 'extension',
          confidence: ext.confidence,
          window_start: ext.windowStart,
          window_end: ext.windowEnd,
          indoor_start: ext.indoorStart,
          indoor_end: ext.indoorEnd,
          reasoning: ext.reasoning,
          inputs_used: JSON.stringify(['extension_calendar']),
          computed_at: Date.now(),
        };
        recommendations.push(assembleRecommendation(id, signature, extCache));
        continue;
      }

      const ruleBase = computeRuleBaseline(cat, loc, year);
      if (ruleBase.confidence >= CONFIDENCE_THRESHOLD) {
        cache = await writeCache(sql, id, signature, 'rule',
          ruleBase.confidence, ruleBase, null, ruleBase.inputsUsed, loc.regionId);
      } else {
        // Low-confidence: enqueue job and return an unknown stub. Do NOT
        // write the cache — a stale rule-based entry would prevent the worker
        // from ever being the source of truth.
        await dbRun(
          sql,
          `INSERT INTO recommendation_jobs (id, catalog_seed_id, location_signature, created_at)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (catalog_seed_id, location_signature) DO UPDATE
             SET status = 'pending', attempts = 0, last_error = NULL
             WHERE recommendation_jobs.status IN ('done', 'failed')`,
          [nanoid(), id, signature, Date.now()],
        );
        pending.push(id);
        recommendations.push({
          catalogSeedId: id,
          locationSignature: signature,
          computedAt: Date.now(),
          source: 'rule',
          confidence: ruleBase.confidence,
          verdict: 'unknown',
          recommendedRange: null,
          indoorRange: null,
          dailyScores: { anchorDate: todayStr(), scores: new Array(60).fill(0) },
          reasoning: null,
          inputsUsed: ruleBase.inputsUsed,
        });
        continue;
      }
    }
    recommendations.push(assembleRecommendation(id, signature, cache!));
  }

  return c.json({ ok: true, data: { recommendations, pending } });
});
