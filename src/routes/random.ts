import { Hono } from 'hono';
import type { AppEnv } from '../index';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { dbAll, dbGet } from '../db/helpers';
import { getSql } from '../db/client';
import { pickWeightedSeed, type SeedForPick } from '../lib/randomPick';

export const randomRoutes = new Hono<AppEnv>();

const auth = [requireAuth(), requireHousehold()] as const;

interface SeedDetailRow {
  id: string;
  household_id: string;
  catalog_id: string | null;
  state: string;
  packet_count: number;
  location_id: string | null;
  year_packed: number | null;
  source: string;
  custom_name: string | null;
  custom_variety: string | null;
  custom_company: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * GET /api/seeds/random
 *
 * Returns a single active seed picked by `pickWeightedSeed` (older-packet
 * bias). If the household has no active seeds, returns 404 so the iOS
 * client can show a gentle empty state.
 */
randomRoutes.get('/seeds/random', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const sql = getSql(c.env);
  const candidates = await dbAll<SeedForPick>(
    sql,
    `SELECT id, year_packed
       FROM seeds
      WHERE household_id = $1
        AND state = 'active'
        AND deleted_at IS NULL`,
    [householdId],
  );

  if (candidates.length === 0) {
    return c.json(
      { ok: false, error: { code: 'no_seeds', message: 'No active seeds to pick from' } },
      404,
    );
  }

  const currentYear = new Date().getUTCFullYear();
  const chosen = pickWeightedSeed(candidates, currentYear);
  if (!chosen) {
    return c.json(
      { ok: false, error: { code: 'no_seeds', message: 'No active seeds to pick from' } },
      404,
    );
  }

  const seed = await dbGet<SeedDetailRow>(
    sql,
    `SELECT id, household_id, catalog_id, state, packet_count, location_id,
            year_packed, source, custom_name, custom_variety, custom_company,
            notes, created_at, updated_at
       FROM seeds WHERE id = $1 AND household_id = $2 LIMIT 1`,
    [chosen.id, householdId],
  );
  return c.json({ ok: true, data: { seed } });
});
