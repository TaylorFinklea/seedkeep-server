import { Hono } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { dbAll, dbGet, dbRun } from '../db/helpers';
import { getSql } from '../db/client';

export const catalogRoutes = new Hono<AppEnv>();

// The catalog is global; lookups require a signed-in user (so we can
// rate-limit + audit later) but NOT a household. Per-route middleware
// composition because `use('*')` bleeds across sibling routers.
const authOnly = requireAuth();

interface CatalogSeedRow {
  id: string;
  barcode: string | null;
  perceptual_hash: string | null;
  common_name: string;
  scientific_name: string | null;
  variety: string | null;
  company: string | null;
  instructions: string | null;
  viability_years: number | null;
  days_to_germinate_min: number | null;
  days_to_germinate_max: number | null;
  days_to_maturity_min: number | null;
  days_to_maturity_max: number | null;
  soil_temp_min_f: number | null;
  soil_temp_max_f: number | null;
  seed_depth_inches: number | null;
  plant_spacing_inches: number | null;
  row_spacing_inches: number | null;
  sun_requirement: 'full' | 'partial' | 'shade' | null;
  frost_tolerance: 'tender' | 'half_hardy' | 'hardy' | null;
  sow_method: 'direct' | 'transplant' | 'either' | null;
  life_cycle: 'annual' | 'biennial' | 'perennial' | null;
  hardiness_zone_min: number | null;
  hardiness_zone_max: number | null;
  status: 'pending' | 'published' | 'rejected';
  confidence: number | null;
  created_at: number;
  updated_at: number;
  published_at: number | null;
}

const CATALOG_SELECT = `
  id, barcode, perceptual_hash, common_name, scientific_name, variety, company,
  instructions, viability_years,
  days_to_germinate_min, days_to_germinate_max,
  days_to_maturity_min, days_to_maturity_max,
  soil_temp_min_f, soil_temp_max_f,
  seed_depth_inches, plant_spacing_inches, row_spacing_inches,
  sun_requirement, frost_tolerance, sow_method, life_cycle,
  hardiness_zone_min, hardiness_zone_max,
  status, confidence, created_at, updated_at, published_at
`;

/**
 * GET /api/catalog/lookup?barcode=<UPC|EAN>
 *
 * Returns the published catalog entry matching the barcode, or null.
 * The catalog is global — household scoping does not apply here. Pending
 * entries are NOT returned: until reviewed, they're internal only.
 */
catalogRoutes.get('/catalog/lookup', authOnly, async (c) => {
  const barcode = c.req.query('barcode')?.trim();
  if (!barcode) {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'Missing barcode' } }, 400);
  }
  const sql = getSql(c.env);
  const hit = await dbGet<CatalogSeedRow>(
    sql,
    `SELECT ${CATALOG_SELECT}
       FROM catalog_seeds
      WHERE barcode = $1 AND status = 'published'
      ORDER BY published_at DESC
      LIMIT 1`,
    [barcode],
  );
  return c.json({ ok: true, data: { catalog_seed: hit } });
});

/**
 * POST /api/catalog/lookup-hash
 * body: { perceptual_hash: string }
 */
catalogRoutes.post('/catalog/lookup-hash', authOnly, async (c) => {
  const body = await c.req.json().catch(() => null);
  const hash = (body?.perceptual_hash as string | undefined)?.trim();
  if (!hash) {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'Missing perceptual_hash' } }, 400);
  }
  const sql = getSql(c.env);
  const candidates = await dbAll<CatalogSeedRow>(
    sql,
    `SELECT ${CATALOG_SELECT}
       FROM catalog_seeds
      WHERE perceptual_hash = $1 AND status = 'published'
      ORDER BY published_at DESC
      LIMIT 5`,
    [hash],
  );
  return c.json({ ok: true, data: { matches: candidates } });
});

/**
 * GET /api/catalog/:id — fetch a single (published) catalog entry.
 */
catalogRoutes.get('/catalog/:id', authOnly, async (c) => {
  const id = c.req.param('id');
  const sql = getSql(c.env);
  const seed = await dbGet<CatalogSeedRow>(
    sql,
    `SELECT ${CATALOG_SELECT}
       FROM catalog_seeds WHERE id = $1 AND status = 'published' LIMIT 1`,
    [id],
  );
  if (!seed) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Catalog entry not found' } }, 404);
  }
  return c.json({ ok: true, data: { catalog_seed: seed } });
});

// ─── Catalog feedback ────────────────────────────────────────────────
// Phase 4 D · community-catalog correction collection. Users can submit
// free-form feedback about a catalog entry; reviewers process the queue
// out of band (no in-app review yet). Stored in `catalog_feedback`.

const feedbackAuth = [requireAuth(), requireHousehold()] as const;

const FeedbackBody = z.object({
  body: z.string().min(1).max(2000),
  // Optional pointer to the specific field the user was looking at —
  // e.g. "days_to_maturity_max" or "instructions".
  field_hint: z.string().max(64).optional(),
});

/**
 * POST /api/catalog/:id/feedback
 * Records a user-submitted correction / observation about a catalog
 * entry. Always returns the created feedback id on success.
 */
catalogRoutes.post('/catalog/:id/feedback', ...feedbackAuth, async (c) => {
  const catalogId = c.req.param('id');
  const sql = getSql(c.env);

  const exists = await dbGet<{ id: string }>(
    sql,
    `SELECT id FROM catalog_seeds WHERE id = $1 LIMIT 1`,
    [catalogId],
  );
  if (!exists) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Catalog entry not found' } }, 404);
  }

  let parsed: z.infer<typeof FeedbackBody>;
  try {
    const raw = await c.req.json();
    parsed = FeedbackBody.parse(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Invalid body';
    return c.json({ ok: false, error: { code: 'bad_request', message } }, 400);
  }

  const householdId = c.get('householdId') as string;
  const userId = c.get('userId') as string;
  const now = Date.now();
  const id = `cf_${nanoid(12)}`;

  await dbRun(
    sql,
    `INSERT INTO catalog_feedback
        (id, catalog_seed_id, household_id, user_id, body, field_hint, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7)`,
    [id, catalogId, householdId, userId, parsed.body, parsed.field_hint ?? null, now],
  );

  return c.json({ ok: true, data: { id } });
});
