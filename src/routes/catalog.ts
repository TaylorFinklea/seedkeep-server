import { Hono } from 'hono';
import type { AppEnv } from '../index';
import { requireAuth } from '../middleware/auth';
import { dbAll, dbGet } from '../db/helpers';
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
  variety: string | null;
  company: string | null;
  instructions: string | null;
  viability_years: number | null;
  status: 'pending' | 'published' | 'rejected';
  confidence: number | null;
  created_at: number;
  updated_at: number;
  published_at: number | null;
}

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
    `SELECT id, barcode, perceptual_hash, common_name, variety, company,
            instructions, viability_years, status, confidence,
            created_at, updated_at, published_at
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
    `SELECT id, barcode, perceptual_hash, common_name, variety, company,
            instructions, viability_years, status, confidence,
            created_at, updated_at, published_at
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
    `SELECT id, barcode, perceptual_hash, common_name, variety, company,
            instructions, viability_years, status, confidence,
            created_at, updated_at, published_at
       FROM catalog_seeds WHERE id = $1 AND status = 'published' LIMIT 1`,
    [id],
  );
  if (!seed) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Catalog entry not found' } }, 404);
  }
  return c.json({ ok: true, data: { catalog_seed: seed } });
});
