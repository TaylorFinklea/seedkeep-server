import { Hono } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { dbAll, dbBatch, dbGet, dbRun } from '../db/helpers';
import { getSql } from '../db/client';
import { zipToRegion } from '../lib/recommendation/region';

export const householdRoutes = new Hono<AppEnv>();

// Per-route middleware composition. `use('*', requireAuth())` would bleed
// to sibling routers mounted at the same `/api` prefix.
const authOnly = requireAuth();
const auth = [requireAuth(), requireHousehold()] as const;

interface HouseholdRow {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

interface MembershipRow {
  household_id: string;
  user_id: string;
  role: 'owner' | 'member';
  joined_at: number;
}

interface InviteRow {
  id: string;
  household_id: string;
  code: string;
  invited_by: string;
  expires_at: number;
  claimed_by: string | null;
  claimed_at: number | null;
  created_at: number;
}

const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
const INVITE_CODE_BYTES = 12;                   // ~16 chars urlsafe; collision-safe

const createHouseholdSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
});

const LocationBody = z.object({ zip: z.string().regex(/^\d{5}$/) });

interface ZipLocationRow {
  zip: string;
  latitude: number;
  longitude: number;
  usda_zone: string;
  avg_last_frost: string;
  avg_first_frost: string;
}

/**
 * POST /api/households
 *
 * Creates a household for the signed-in user if they don't have one yet.
 * Idempotent: if a membership already exists, returns the existing
 * household. iOS calls this once after first sign-in.
 */
householdRoutes.post('/households', authOnly, async (c) => {
  const userId = c.get('userId');
  const sql = getSql(c.env);
  const body = await c.req.json().catch(() => ({}));
  const parsed = createHouseholdSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'Invalid body' } }, 400);
  }

  const existing = await dbGet<MembershipRow>(
    sql,
    `SELECT household_id, user_id, role, joined_at FROM memberships WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  if (existing) {
    const h = await dbGet<HouseholdRow>(
      sql,
      `SELECT id, name, created_at, updated_at FROM households WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [existing.household_id],
    );
    if (h) {
      return c.json({ ok: true, data: { household: h, role: existing.role } });
    }
  }

  const id = nanoid();
  const now = Date.now();
  const name = parsed.data.name ?? 'My household';

  await dbBatch(sql, [
    {
      sql: `INSERT INTO households (id, name, created_at, updated_at)
            VALUES ($1, $2, $3, $4)`,
      params: [id, name, now, now],
    },
    {
      sql: `INSERT INTO memberships (household_id, user_id, role, joined_at)
            VALUES ($1, $2, 'owner', $3)`,
      params: [id, userId, now],
    },
  ]);

  return c.json({
    ok: true,
    data: {
      household: { id, name, created_at: now, updated_at: now },
      role: 'owner',
    },
  });
});

/**
 * GET /api/households/me — current user's household + members.
 */
householdRoutes.get('/households/me', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const sql = getSql(c.env);
  const household = await dbGet<HouseholdRow>(
    sql,
    `SELECT id, name, created_at, updated_at FROM households WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [householdId],
  );
  if (!household) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Household missing' } }, 404);
  }
  const members = await dbAll<{
    user_id: string; role: string; joined_at: number;
    name: string | null; email: string | null;
  }>(
    sql,
    `SELECT m.user_id, m.role, m.joined_at, u.name, u.email
       FROM memberships m
       JOIN "user" u ON u.id = m.user_id
      WHERE m.household_id = $1
      ORDER BY m.joined_at ASC`,
    [householdId],
  );
  return c.json({ ok: true, data: { household, members } });
});

/**
 * POST /api/households/me/invites — create an invite code.
 *
 * Only members can invite. The returned `code` is embedded in a universal
 * link by the iOS client (e.g., `https://seedkeep.app/invite/<code>`).
 */
householdRoutes.post('/households/me/invites', ...auth, async (c) => {
  const userId = c.get('userId');
  const householdId = c.get('householdId');
  const sql = getSql(c.env);

  const id = nanoid();
  const code = nanoid(INVITE_CODE_BYTES);
  const now = Date.now();
  const expiresAt = now + INVITE_TTL_MS;

  await dbRun(
    sql,
    `INSERT INTO invites (id, household_id, code, invited_by, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, householdId, code, userId, expiresAt, now],
  );

  return c.json({
    ok: true,
    data: {
      invite: { id, code, expires_at: expiresAt },
    },
  });
});

/**
 * POST /api/invites/:code/accept — claim an invite.
 *
 * Phase 1 enforces 1:1 user-to-household: a user with an existing
 * membership must explicitly leave first. Schema permits multiple
 * memberships so we can lift the restriction later.
 */
householdRoutes.post('/invites/:code/accept', authOnly, async (c) => {
  const userId = c.get('userId');
  const code = c.req.param('code');
  const sql = getSql(c.env);

  const existing = await dbGet<MembershipRow>(
    sql,
    `SELECT household_id, user_id, role, joined_at FROM memberships WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  if (existing) {
    return c.json(
      {
        ok: false,
        error: {
          code: 'already_member',
          message: 'User already belongs to a household. Leave the current household to accept an invite.',
        },
      },
      409,
    );
  }

  const invite = await dbGet<InviteRow>(
    sql,
    `SELECT id, household_id, code, invited_by, expires_at, claimed_by, claimed_at, created_at
       FROM invites
      WHERE code = $1
      LIMIT 1`,
    [code],
  );
  if (!invite) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Invite not found' } }, 404);
  }
  if (invite.claimed_by) {
    return c.json({ ok: false, error: { code: 'already_claimed', message: 'Invite has already been used' } }, 409);
  }
  if (invite.expires_at < Date.now()) {
    return c.json({ ok: false, error: { code: 'expired', message: 'Invite expired' } }, 410);
  }

  const now = Date.now();
  const claimed = await sql.begin(async (tx) => {
    const updateResult = await tx.unsafe(
      `UPDATE invites
          SET claimed_by = $1, claimed_at = $2
        WHERE id = $3
          AND claimed_by IS NULL
          AND expires_at > $4`,
      [userId, now, invite.id, now],
    );
    if (Number((updateResult as { count?: number }).count ?? 0) === 0) {
      return false;
    }
    await tx.unsafe(
      `INSERT INTO memberships (household_id, user_id, role, joined_at)
       VALUES ($1, $2, 'member', $3)
       ON CONFLICT DO NOTHING`,
      [invite.household_id, userId, now],
    );
    return true;
  });
  if (!claimed) {
    return c.json({ ok: false, error: { code: 'already_claimed', message: 'Invite has already been used or expired.' } }, 409);
  }

  const household = await dbGet<HouseholdRow>(
    sql,
    `SELECT id, name, created_at, updated_at FROM households WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [invite.household_id],
  );

  return c.json({
    ok: true,
    data: {
      household,
      role: 'member',
    },
  });
});

/**
 * PUT /api/households/me/location — set home ZIP and denormalize location data.
 *
 * Looks up the ZIP in zip_locations and writes lat/lon, USDA zone, and frost
 * dates onto the household row for use by the recommendation engine.
 */
householdRoutes.put('/households/me/location', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const sql = getSql(c.env);

  const body = await c.req.json().catch(() => null);
  const parsed = LocationBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: { code: 'invalid_zip', message: 'ZIP must be 5 digits' } }, 400);
  }

  const loc = await dbGet<ZipLocationRow>(
    sql,
    `SELECT zip, latitude, longitude, usda_zone, avg_last_frost, avg_first_frost
       FROM zip_locations WHERE zip = $1 LIMIT 1`,
    [parsed.data.zip],
  );
  if (!loc) {
    return c.json({ ok: false, error: { code: 'unknown_zip', message: 'ZIP not found in dataset' } }, 404);
  }

  const now = Date.now();
  const regionId = zipToRegion(loc.zip);
  await dbRun(
    sql,
    `UPDATE households
        SET home_zip = $1, latitude = $2, longitude = $3, usda_zone = $4,
            avg_last_frost = $5, avg_first_frost = $6, region_id = $7, updated_at = $8
      WHERE id = $9`,
    [loc.zip, loc.latitude, loc.longitude, loc.usda_zone, loc.avg_last_frost, loc.avg_first_frost, regionId, now, householdId],
  );

  return c.json({ ok: true, data: {
    zip: loc.zip,
    latitude: loc.latitude,
    longitude: loc.longitude,
    usdaZone: loc.usda_zone,
    avgLastFrost: loc.avg_last_frost,
    avgFirstFrost: loc.avg_first_frost,
    regionId,
  } });
});

// ─── Sprout (AI assistant) — BYOK key management ───────────────────────────
//
// The user pastes their Anthropic API key once into Settings; we encrypt
// it with AES-256-GCM under `ASSISTANT_KEY_MASTER` and store the ciphertext
// + IV + auth tag. The key is never echoed back to the client; iOS only
// learns "configured: true/false" so it can show the right Settings state.

const SetAssistantKeyBody = z.object({
  provider: z.literal('anthropic'),
  key: z.string().min(8, 'key looks too short').max(512, 'key looks too long'),
});

interface AssistantKeyRow {
  household_id: string;
  provider: string;
  created_at: number;
  updated_at: number;
}

/**
 * PUT /api/households/me/assistant_key
 *
 * Body: `{ provider: 'anthropic', key: string }`. Server encrypts + UPSERTs.
 * Returns `{ provider, configured: true, updatedAt }`. Never echoes the key.
 *
 * 503 not_configured when `ASSISTANT_KEY_MASTER` is missing on the server.
 */
householdRoutes.put('/households/me/assistant_key', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const sql = getSql(c.env);

  if (!c.env.ASSISTANT_KEY_MASTER) {
    return c.json({ ok: false, error: { code: 'not_configured',
      message: 'Server is missing ASSISTANT_KEY_MASTER' } }, 503);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = SetAssistantKeyBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: { code: 'bad_request',
      message: parsed.error.issues.map((i) => i.message).join('; ') } }, 400);
  }

  const { provider, key } = parsed.data;
  const { encryptApiKey } = await import('../lib/assistant/keyEncryption');
  const enc = encryptApiKey(key, c.env.ASSISTANT_KEY_MASTER);

  const now = Date.now();
  await dbRun(
    sql,
    `INSERT INTO assistant_keys
       (household_id, provider, encrypted_key, key_iv, key_tag, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (household_id, provider) DO UPDATE SET
       encrypted_key = EXCLUDED.encrypted_key,
       key_iv        = EXCLUDED.key_iv,
       key_tag       = EXCLUDED.key_tag,
       updated_at    = EXCLUDED.updated_at`,
    [householdId, provider, enc.ciphertext, enc.iv, enc.tag, now],
  );

  return c.json({ ok: true, data: { provider, configured: true, updatedAt: now } });
});

/**
 * DELETE /api/households/me/assistant_key?provider=anthropic
 *
 * Revoke the BYOK key for a provider. Idempotent — returns 200 even if
 * no key was configured.
 */
householdRoutes.delete('/households/me/assistant_key', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const sql = getSql(c.env);
  const provider = c.req.query('provider') ?? 'anthropic';
  if (provider !== 'anthropic') {
    return c.json({ ok: false, error: { code: 'bad_request',
      message: 'provider must be anthropic' } }, 400);
  }
  await dbRun(
    sql,
    `DELETE FROM assistant_keys WHERE household_id = $1 AND provider = $2`,
    [householdId, provider],
  );
  return c.json({ ok: true, data: { provider, configured: false } });
});

/**
 * GET /api/households/me/assistant_key
 *
 * Returns the configured-state for each provider known to the server. Never
 * exposes the encrypted bytes or the plaintext.
 */
householdRoutes.get('/households/me/assistant_key', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const sql = getSql(c.env);
  const rows = await dbAll<AssistantKeyRow>(
    sql,
    `SELECT household_id, provider, created_at, updated_at
       FROM assistant_keys WHERE household_id = $1`,
    [householdId],
  );
  const providers = rows.map((r) => ({
    provider: r.provider,
    configured: true,
    updatedAt: r.updated_at,
  }));
  return c.json({ ok: true, data: { providers } });
});
