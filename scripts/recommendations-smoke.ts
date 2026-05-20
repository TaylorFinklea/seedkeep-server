/**
 * Recommendations smoke test — exercises the smart-planting-window feature
 * end-to-end against a locally-running dev server (`bun run dev`) + local
 * Postgres. Not part of the automated test suite; run manually with:
 *
 *   bun run scripts/recommendations-smoke.ts
 *
 * Prerequisites:
 *   - `bun run dev` is running (default port 8787)
 *   - Local Postgres is running with migrations 0001–0008 applied
 *   - zip_locations seeded (scripts/seed-zip-locations.ts)
 */

import postgres from 'postgres';

const BASE_URL = 'http://localhost:8787/api';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://seedkeep:dev-only@localhost:5432/seedkeep';

// ── helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    console.error(`\nCould not reach ${BASE_URL}${path}.`);
    console.error('Please start the dev server first:  bun run dev\n');
    throw err;
  }
  const body = await res.json();
  return { status: res.status, body };
}

function nanoid12(): string {
  return Math.random().toString(36).slice(2, 14).padEnd(12, '0');
}

// ── fixtures ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const sql = postgres(DATABASE_URL, {
    transform: { undefined: null },
    onnotice: () => { /* silence */ },
  });

  // IDs we'll clean up at the end
  const userId1 = `smoke-user-1-${nanoid12()}`;
  const userId2 = `smoke-user-2-${nanoid12()}`;
  const householdId1 = `smoke-hh-1-${nanoid12()}`;
  const householdId2 = `smoke-hh-2-${nanoid12()}`;
  const token1 = `smoke-token-1-${nanoid12()}`;
  const token2 = `smoke-token-2-${nanoid12()}`;
  const sessionId1 = `smoke-sess-1-${nanoid12()}`;
  const sessionId2 = `smoke-sess-2-${nanoid12()}`;
  const catalogSeedId = `smoke-cat-${nanoid12()}`;
  let insertedCatalogSeed = false;

  console.log('\n── recommendations smoke test ──────────────────────────────────────\n');

  try {
    // ── seed fixtures ─────────────────────────────────────────────────────────
    const now = Date.now();
    const expiresAt = now + 1000 * 60 * 60 * 24; // 24 hours

    // User 1 (with location)
    await sql.unsafe(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, FALSE, $4, $4)`,
      [userId1, 'Smoke Test User 1', `smoke1-${nanoid12()}@test.invalid`, now],
    );
    await sql.unsafe(
      `INSERT INTO session (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [sessionId1, expiresAt, token1, now, userId1],
    );
    await sql.unsafe(
      `INSERT INTO households (id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)`,
      [householdId1, 'Smoke Household 1', now],
    );
    await sql.unsafe(
      `INSERT INTO memberships (household_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)`,
      [householdId1, userId1, now],
    );

    // User 2 (no location — stays NULL to test check 9)
    await sql.unsafe(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, FALSE, $4, $4)`,
      [userId2, 'Smoke Test User 2', `smoke2-${nanoid12()}@test.invalid`, now],
    );
    await sql.unsafe(
      `INSERT INTO session (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [sessionId2, expiresAt, token2, now, userId2],
    );
    await sql.unsafe(
      `INSERT INTO households (id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)`,
      [householdId2, 'Smoke Household 2', now],
    );
    await sql.unsafe(
      `INSERT INTO memberships (household_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)`,
      [householdId2, userId2, now],
    );

    // ── check 1: PUT /households/me/location valid ZIP ────────────────────────
    {
      const { status, body } = await api('PUT', '/households/me/location', {
        token: token1,
        body: { zip: '10001' },
      });
      const b = body as { ok: boolean; data?: { usdaZone?: string } };
      check(
        'Check 1: PUT /households/me/location with valid ZIP → 200, usdaZone non-empty',
        status === 200 && b.ok === true && typeof b.data?.usdaZone === 'string' && b.data.usdaZone.length > 0,
        `status=${status} usdaZone=${b.data?.usdaZone}`,
      );
    }

    // ── check 2: PUT /households/me/location invalid ZIP format ──────────────
    {
      const { status, body } = await api('PUT', '/households/me/location', {
        token: token1,
        body: { zip: 'abc' },
      });
      const b = body as { ok: boolean; error?: { code?: string } };
      check(
        'Check 2: PUT /households/me/location with bad format → 400 invalid_zip',
        status === 400 && b.error?.code === 'invalid_zip',
        `status=${status} code=${b.error?.code}`,
      );
    }

    // ── check 3: PUT /households/me/location unknown ZIP ─────────────────────
    {
      const { status, body } = await api('PUT', '/households/me/location', {
        token: token1,
        body: { zip: '00000' },
      });
      const b = body as { ok: boolean; error?: { code?: string } };
      check(
        'Check 3: PUT /households/me/location with unknown ZIP → 404 unknown_zip',
        status === 404 && b.error?.code === 'unknown_zip',
        `status=${status} code=${b.error?.code}`,
      );
    }

    // ── check 4: GET /recommendations/:id without token → 401 ────────────────
    {
      const { status } = await api('GET', '/recommendations/some-bogus-id');
      check(
        'Check 4: GET /recommendations/:id with no token → 401',
        status === 401,
        `status=${status}`,
      );
    }

    // ── find or insert a catalog_seeds row with full horticultural data ───────
    let targetCatalogId: string;
    const existingRows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM catalog_seeds
        WHERE frost_tolerance IS NOT NULL
          AND sow_method IS NOT NULL
          AND soil_temp_min_f IS NOT NULL
          AND days_to_maturity_max IS NOT NULL
        LIMIT 1`,
      [],
    );

    if (existingRows.length > 0) {
      targetCatalogId = existingRows[0].id;
      console.log(`  info  Using existing catalog_seeds row: ${targetCatalogId}`);
    } else {
      insertedCatalogSeed = true;
      targetCatalogId = catalogSeedId;
      await sql.unsafe(
        `INSERT INTO catalog_seeds
           (id, common_name, variety, status, frost_tolerance, sow_method,
            soil_temp_min_f, soil_temp_max_f, days_to_maturity_min, days_to_maturity_max,
            hardiness_zone_min, hardiness_zone_max, created_at, updated_at)
         VALUES ($1,'Tomato','Smoke Test Roma','published','tender','transplant',
                 60,85,70,90,5,10,$2,$2)`,
        [targetCatalogId, now],
      );
      console.log(`  info  Inserted test catalog_seeds row: ${targetCatalogId}`);
    }

    // ── check 5: GET /recommendations/:id → 200, source='rule', 60 scores ────
    {
      const { status, body } = await api('GET', `/recommendations/${targetCatalogId}`, {
        token: token1,
      });
      const b = body as {
        ok: boolean;
        data?: {
          verdict?: string;
          source?: string;
          dailyScores?: { scores?: number[] };
        };
      };
      check(
        'Check 5: GET /recommendations/:id with full hort data → 200, verdict present, 60 scores, source=rule',
        status === 200 &&
          b.ok === true &&
          typeof b.data?.verdict === 'string' &&
          b.data?.source === 'rule' &&
          Array.isArray(b.data?.dailyScores?.scores) &&
          b.data!.dailyScores!.scores!.length === 60,
        `status=${status} source=${b.data?.source} verdict=${b.data?.verdict} scores.length=${b.data?.dailyScores?.scores?.length}`,
      );
    }

    // ── check 6: GET /recommendations/:id bogus ID → 404 not_found ───────────
    {
      const { status, body } = await api('GET', '/recommendations/does-not-exist-xyz', {
        token: token1,
      });
      const b = body as { ok: boolean; error?: { code?: string } };
      check(
        'Check 6: GET /recommendations/bogus-id → 404 not_found',
        status === 404 && b.error?.code === 'not_found',
        `status=${status} code=${b.error?.code}`,
      );
    }

    // ── check 7: POST /recommendations/bulk → 200, populated results ─────────
    {
      // Find a couple more IDs for bulk (reuse targetCatalogId + existing tomato row)
      const otherRows = await sql.unsafe<{ id: string }[]>(
        `SELECT id FROM catalog_seeds WHERE id != $1 LIMIT 2`,
        [targetCatalogId],
      );
      const bulkIds = [targetCatalogId, ...otherRows.map((r) => r.id)].slice(0, 3);

      const { status, body } = await api('POST', '/recommendations/bulk', {
        token: token1,
        body: { catalogSeedIds: bulkIds },
      });
      const b = body as {
        ok: boolean;
        data?: {
          recommendations?: unknown[];
          pending?: unknown[];
        };
      };
      check(
        'Check 7: POST /recommendations/bulk → 200, recommendations array, pending array',
        status === 200 &&
          b.ok === true &&
          Array.isArray(b.data?.recommendations) &&
          b.data!.recommendations!.length > 0 &&
          Array.isArray(b.data?.pending),
        `status=${status} recommendations.length=${b.data?.recommendations?.length} pending.length=${b.data?.pending?.length}`,
      );
    }

    // ── check 8: trigger invalidation ────────────────────────────────────────
    {
      // First, confirm a cache row exists for check 5's seed
      const beforeRows = await sql.unsafe<{ catalog_seed_id: string }[]>(
        `SELECT catalog_seed_id FROM recommendation_cache WHERE catalog_seed_id = $1`,
        [targetCatalogId],
      );
      const cacheExistsBefore = beforeRows.length > 0;

      // Trigger the catalog invalidation trigger by changing soil_temp_min_f
      await sql.unsafe(
        `UPDATE catalog_seeds SET soil_temp_min_f = COALESCE(soil_temp_min_f, 0) + 1 WHERE id = $1`,
        [targetCatalogId],
      );

      // The trigger should have deleted the cache row
      const afterRows = await sql.unsafe<{ catalog_seed_id: string }[]>(
        `SELECT catalog_seed_id FROM recommendation_cache WHERE catalog_seed_id = $1`,
        [targetCatalogId],
      );
      const cacheGoneAfter = afterRows.length === 0;

      check(
        'Check 8: catalog UPDATE trigger invalidates recommendation_cache row',
        cacheExistsBefore && cacheGoneAfter,
        `cacheExistsBefore=${cacheExistsBefore} cacheGoneAfter=${cacheGoneAfter}`,
      );
    }

    // ── check 9: no-location household → 409 no_household_location ───────────
    {
      // token2 is for household 2 which has no location set
      const { status, body } = await api('GET', `/recommendations/${targetCatalogId}`, {
        token: token2,
      });
      const b = body as { ok: boolean; error?: { code?: string } };
      check(
        'Check 9: GET /recommendations/:id with no-location household → 409 no_household_location',
        status === 409 && b.error?.code === 'no_household_location',
        `status=${status} code=${b.error?.code}`,
      );
    }

  } finally {
    // ── cleanup ───────────────────────────────────────────────────────────────
    console.log('\n── cleanup ─────────────────────────────────────────────────────────\n');

    if (insertedCatalogSeed) {
      await sql.unsafe(`DELETE FROM catalog_seeds WHERE id = $1`, [catalogSeedId]);
      console.log('  Deleted test catalog_seeds row');
    } else {
      // Restore soil_temp_min_f: we incremented it by 1, so subtract 1 back
      // Only restore if the check ran (i.e., we reached check 8)
      try {
        await sql.unsafe(
          `UPDATE catalog_seeds SET soil_temp_min_f = COALESCE(soil_temp_min_f, 1) - 1 WHERE id = $1`,
          [catalogSeedId],
        );
      } catch {
        // May not apply if we used an existing row — skip silently
      }
    }

    // Delete sessions (cascade not guaranteed — explicit delete)
    await sql.unsafe(`DELETE FROM session WHERE id IN ($1, $2)`, [sessionId1, sessionId2]);
    // Delete memberships and households (CASCADE removes memberships)
    await sql.unsafe(`DELETE FROM households WHERE id IN ($1, $2)`, [householdId1, householdId2]);
    // Delete users (CASCADE removes sessions, memberships via FK)
    await sql.unsafe(`DELETE FROM "user" WHERE id IN ($1, $2)`, [userId1, userId2]);

    console.log('  Deleted smoke test fixtures');

    await sql.end();
  }

  // ── summary ───────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n── ${passed}/${total} checks passed ──────────────────────────────────────────\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
