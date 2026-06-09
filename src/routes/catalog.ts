import { Hono } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { dbAll, dbGet, dbRun } from '../db/helpers';
import { getSql } from '../db/client';
import {
  CORRECTABLE_FIELDS,
  AUTO_APPLY_FIELDS,
  ENUM_VALUES,
  SANITY_BOUNDS,
  validateFieldValue,
  describeBounds,
} from '../lib/catalog/fieldBounds';
import { scrubText } from '../lib/catalog/sanitize';

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

/** POST /api/catalog/lookup-hash */
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

/** GET /api/catalog/:id */
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

// ─── Catalog feedback / corrections — Phase 4D ──────────────────────

const feedbackAuth = [requireAuth(), requireHousehold()] as const;
const mineAuth = [requireAuth()] as const;

/**
 * Feedback body — backward compatible with the legacy free-form shape
 * (just `body` + optional `field_hint`) and extended with the structured
 * Phase 4D fields. All structured fields are optional so old clients
 * keep working.
 */
const FeedbackBody = z.object({
  body: z.string().min(1).max(2000),
  field_hint: z.string().max(64).optional(),
  field_name: z.string().max(64).optional(),
  suggested_value: z.string().min(1).max(2000).optional(),
  client_seen_value: z.union([z.string(), z.null()]).optional(),
  user_acknowledged_bounds: z.boolean().optional(),
});

const PER_HOUR_LIMIT = 20;
const PER_DAY_LIMIT = 30;

interface CorrectionRow {
  id: string;
  catalog_seed_id: string | null;
  catalog_seed_name: string | null;
  field_name: string | null;
  value_type: string | null;
  suggested_value: string | null;
  client_seen_value: string | null;
  body: string | null;
  status: 'open' | 'reviewed' | 'applied' | 'dismissed';
  ai_review_score: number | null;
  ai_notes: string | null;
  dismissed_reason: string | null;
  conflict_with_id: string | null;
  user_acknowledged_bounds: boolean;
  created_at: number;
  reviewed_at: number | null;
  applied_at: number | null;
  escalated_at: number | null;
  updated_at: number;
  ai_locked_at: number | null;
}

function correctionDTO(row: CorrectionRow): Record<string, unknown> {
  return {
    id: row.id,
    catalog_seed_id: row.catalog_seed_id,
    catalog_seed_name: row.catalog_seed_name,
    field_name: row.field_name,
    value_type: row.value_type,
    suggested_value: row.suggested_value,
    client_seen_value: row.client_seen_value,
    body: row.body,
    status: row.status,
    ai_review_score: row.ai_review_score,
    ai_notes: row.ai_notes,
    dismissed_reason: row.dismissed_reason,
    conflict_with_id: row.conflict_with_id,
    user_acknowledged_bounds: !!row.user_acknowledged_bounds,
    created_at: row.created_at,
    reviewed_at: row.reviewed_at,
    applied_at: row.applied_at,
    escalated_at: row.escalated_at,
    updated_at: row.updated_at,
    deleted_at: null,
  };
}

function valueTypeFor(field: string): string {
  if (ENUM_VALUES[field]) return 'enum';
  if (SANITY_BOUNDS[field]) {
    if (field === 'seed_depth_inches') return 'numeric';
    return 'integer';
  }
  if (CORRECTABLE_FIELDS.has(field)) return 'text';
  return 'free_form';
}

/**
 * POST /api/catalog/:id/feedback
 * Extended Phase 4D: idempotency replay, structured field correction,
 * per-user rate limiting, server-side bounds validation, partial-unique
 * dedup, and scrub. Legacy body-only shape still inserts cleanly with
 * field_name=NULL.
 */
catalogRoutes.post('/catalog/:id/feedback', ...feedbackAuth, async (c) => {
  const catalogId = c.req.param('id');
  const sql = getSql(c.env);

  const exists = await dbGet<{ id: string; status: string; common_name: string }>(
    sql,
    `SELECT id, status, common_name FROM catalog_seeds WHERE id = $1 LIMIT 1`,
    [catalogId],
  );
  if (!exists) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Catalog entry not found' } }, 404);
  }
  if (exists.status !== 'published') {
    return c.json(
      { ok: false, error: { code: 'catalog_entry_not_published', message: 'Catalog entry not available' } },
      404,
    );
  }

  let parsed: z.infer<typeof FeedbackBody>;
  try {
    const raw = await c.req.json();
    parsed = FeedbackBody.parse(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Invalid body';
    return c.json({ ok: false, error: { code: 'bad_request', message } }, 400);
  }

  // Scrub body.
  const scrubbed = scrubText(parsed.body);
  if (!scrubbed.ok) {
    return c.json(
      { ok: false, error: { code: 'bad_request', message: `body rejected: ${scrubbed.reason}` } },
      400,
    );
  }

  const householdId = c.get('householdId') as string;
  const userId = c.get('userId') as string;
  const now = Date.now();
  const idempotencyKey = c.req.header('Idempotency-Key')?.trim() || null;

  // Idempotency replay — return the existing row's current status, not
  // assumed 'open'. Lets the client distinguish duplicate-vs-withdrawn.
  if (idempotencyKey) {
    const existing = await dbGet<CorrectionRow>(
      sql,
      `SELECT ${CORRECTION_SELECT}
         FROM catalog_feedback
        WHERE idempotency_key = $1 AND user_id = $2
        LIMIT 1`,
      [idempotencyKey, userId],
    );
    if (existing) {
      return c.json({ ok: true, data: { id: existing.id, status: existing.status }, replay: true }, 200);
    }
  }

  // Rate limits.
  const oneHourAgo = now - 3_600_000;
  const oneDayAgo = now - 86_400_000;
  const counts = await dbGet<{ h: number; d: number }>(
    sql,
    `SELECT
       count(*) FILTER (WHERE created_at > $2)::int AS h,
       count(*) FILTER (WHERE created_at > $3)::int AS d
       FROM catalog_feedback WHERE user_id = $1`,
    [userId, oneHourAgo, oneDayAgo],
  );
  if (counts && counts.h >= PER_HOUR_LIMIT) {
    return c.json(
      { ok: false, error: { code: 'rate_limited', message: 'too many submissions in the last hour' }, retry_after_seconds: 1800 },
      429,
    );
  }
  if (counts && counts.d >= PER_DAY_LIMIT) {
    return c.json(
      { ok: false, error: { code: 'rate_limited', message: 'too many submissions today' }, retry_after_seconds: 21600 },
      429,
    );
  }

  // Validate field if structured.
  const fieldName = parsed.field_name?.trim() || null;
  let valueType: string | null = null;
  let suggested: string | null = parsed.suggested_value?.trim() ?? null;
  const userAck = parsed.user_acknowledged_bounds ?? false;

  if (fieldName) {
    if (fieldName !== 'other' && !CORRECTABLE_FIELDS.has(fieldName)) {
      return c.json(
        { ok: false, error: { code: 'bad_request', message: `field_name '${fieldName}' is not correctable` } },
        400,
      );
    }
    valueType = valueTypeFor(fieldName);

    if (suggested === null) {
      return c.json(
        { ok: false, error: { code: 'bad_request', message: 'suggested_value required with field_name' } },
        400,
      );
    }

    // Run server-side bounds validation.
    if (fieldName !== 'other') {
      const validated = validateFieldValue(fieldName, suggested);
      if (!validated.ok) {
        if (!userAck) {
          return c.json(
            {
              ok: false,
              error: {
                code: 'bounds_violation',
                message: validated.reason,
              },
              bounds_hint: validated.bounds_hint,
              can_file_anyway: true,
            },
            400,
          );
        }
        // user acknowledged — accept as-is for human review.
      }
    }
  }

  const id = `cf_${nanoid(12)}`;
  try {
    await dbRun(
      sql,
      `INSERT INTO catalog_feedback
          (id, catalog_seed_id, household_id, user_id, body, field_hint,
           field_name, suggested_value, client_seen_value, value_type,
           catalog_seed_name, user_acknowledged_bounds, idempotency_key,
           status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               'open', $14::BIGINT, $14::BIGINT)`,
      [
        id,
        catalogId,
        householdId,
        userId,
        scrubbed.text,
        parsed.field_hint ?? null,
        fieldName,
        suggested,
        parsed.client_seen_value ?? null,
        valueType,
        exists.common_name,
        userAck,
        idempotencyKey,
        now,
      ],
    );
  } catch (err: unknown) {
    // Per-(user, seed, field) dedup raised 23505.
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      // If it was the idempotency-key collision, the replay branch
      // above should have caught it — fall through to dedup of open
      // corrections.
      const existing = await dbGet<CorrectionRow>(
        sql,
        `SELECT ${CORRECTION_SELECT}
           FROM catalog_feedback
          WHERE user_id = $1 AND catalog_seed_id = $2 AND field_name = $3
            AND status = 'open'
          LIMIT 1`,
        [userId, catalogId, fieldName],
      );
      if (existing) {
        return c.json(
          {
            ok: false,
            error: { code: 'open_correction_exists', message: 'open correction exists' },
            existing: correctionDTO(existing),
          },
          409,
        );
      }
      // Idempotency key collision against a different user_id (rare). Fall through.
      return c.json(
        { ok: false, error: { code: 'open_correction_exists', message: 'duplicate' } },
        409,
      );
    }
    throw err;
  }

  return c.json({ ok: true, data: { id, status: 'open' as const } }, 201);
});

const CORRECTION_SELECT = `
  id, catalog_seed_id, catalog_seed_name, field_name, value_type,
  suggested_value, client_seen_value, body, status,
  ai_review_score, ai_notes, dismissed_reason, conflict_with_id,
  user_acknowledged_bounds, created_at, reviewed_at, applied_at,
  escalated_at, updated_at, ai_locked_at
`;

/**
 * PUT /api/catalog/:id/corrections/:correction_id
 * Allowed only while status='open' AND ai_locked_at IS NULL.
 */
const EditBody = z.object({
  suggested_value: z.string().min(1).max(2000).optional(),
  body: z.string().min(1).max(2000).optional(),
  idempotency_key: z.string().max(128).optional(),
});

catalogRoutes.put('/catalog/:id/corrections/:correction_id', ...feedbackAuth, async (c) => {
  const sql = getSql(c.env);
  const userId = c.get('userId') as string;
  const correctionId = c.req.param('correction_id');

  let parsed: z.infer<typeof EditBody>;
  try {
    parsed = EditBody.parse(await c.req.json());
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid body';
    return c.json({ ok: false, error: { code: 'bad_request', message } }, 400);
  }

  const row = await dbGet<CorrectionRow>(
    sql,
    `SELECT ${CORRECTION_SELECT} FROM catalog_feedback WHERE id = $1 AND user_id = $2`,
    [correctionId, userId],
  );
  if (!row) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'correction not found' } }, 404);
  }
  if (row.status !== 'open' || row.ai_locked_at !== null) {
    return c.json(
      { ok: false, error: { code: 'no_longer_editable', message: 'cannot edit a locked or terminal correction' } },
      409,
    );
  }

  // Validate the new suggested_value against the existing field_name.
  if (parsed.suggested_value !== undefined && row.field_name && row.field_name !== 'other') {
    const v = validateFieldValue(row.field_name, parsed.suggested_value);
    if (!v.ok && !row.user_acknowledged_bounds) {
      return c.json(
        {
          ok: false,
          error: { code: 'bounds_violation', message: v.reason },
          bounds_hint: v.bounds_hint,
          can_file_anyway: true,
        },
        400,
      );
    }
  }

  let bodyText = row.body;
  if (parsed.body !== undefined) {
    const s = scrubText(parsed.body);
    if (!s.ok) {
      return c.json(
        { ok: false, error: { code: 'bad_request', message: `body rejected: ${s.reason}` } },
        400,
      );
    }
    bodyText = s.text;
  }

  const now = Date.now();
  await dbRun(
    sql,
    `UPDATE catalog_feedback
        SET suggested_value = COALESCE($2, suggested_value),
            body = COALESCE($3, body),
            idempotency_key = COALESCE($4, idempotency_key),
            updated_at = $5
      WHERE id = $1`,
    [
      correctionId,
      parsed.suggested_value ?? null,
      bodyText,
      parsed.idempotency_key ?? null,
      now,
    ],
  );

  const updated = await dbGet<CorrectionRow>(
    sql,
    `SELECT ${CORRECTION_SELECT} FROM catalog_feedback WHERE id = $1`,
    [correctionId],
  );
  return c.json({ ok: true, data: updated ? correctionDTO(updated) : null });
});

/** DELETE /api/catalog/:id/corrections/:correction_id — withdraw while open. */
catalogRoutes.delete('/catalog/:id/corrections/:correction_id', ...feedbackAuth, async (c) => {
  const sql = getSql(c.env);
  const userId = c.get('userId') as string;
  const correctionId = c.req.param('correction_id');

  const row = await dbGet<CorrectionRow>(
    sql,
    `SELECT ${CORRECTION_SELECT} FROM catalog_feedback WHERE id = $1 AND user_id = $2`,
    [correctionId, userId],
  );
  if (!row) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'correction not found' } }, 404);
  }
  if (row.status !== 'open') {
    return c.json(
      { ok: false, error: { code: 'already_terminal', message: `correction is ${row.status}` } },
      409,
    );
  }
  const now = Date.now();
  await dbRun(
    sql,
    `UPDATE catalog_feedback
        SET status = 'dismissed', dismissed_reason = 'user_withdrawn',
            reviewed_at = $2, updated_at = $2
      WHERE id = $1`,
    [correctionId, now],
  );
  return c.json({ ok: true, data: { id: correctionId, status: 'dismissed' as const } });
});

/** POST /api/catalog/:id/corrections/:correction_id/escalate */
catalogRoutes.post('/catalog/:id/corrections/:correction_id/escalate', ...feedbackAuth, async (c) => {
  const sql = getSql(c.env);
  const userId = c.get('userId') as string;
  const correctionId = c.req.param('correction_id');

  const row = await dbGet<CorrectionRow>(
    sql,
    `SELECT ${CORRECTION_SELECT} FROM catalog_feedback WHERE id = $1 AND user_id = $2`,
    [correctionId, userId],
  );
  if (!row) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'correction not found' } }, 404);
  }
  if (row.status !== 'dismissed' || row.dismissed_reason !== 'ai_low_confidence') {
    return c.json(
      { ok: false, error: { code: 'not_escalatable', message: 'only ai_low_confidence dismissals can be escalated' } },
      409,
    );
  }
  const now = Date.now();
  await dbRun(
    sql,
    `UPDATE catalog_feedback
        SET status = 'reviewed', dismissed_reason = 'user_escalated',
            escalated_at = $2, reviewed_at = $2, updated_at = $2
      WHERE id = $1`,
    [correctionId, now],
  );
  const updated = await dbGet<CorrectionRow>(
    sql,
    `SELECT ${CORRECTION_SELECT} FROM catalog_feedback WHERE id = $1`,
    [correctionId],
  );
  return c.json({ ok: true, data: updated ? correctionDTO(updated) : null });
});

/** GET /api/catalog/corrections/mine?since=&limit= */
catalogRoutes.get('/catalog/corrections/mine', ...mineAuth, async (c) => {
  const sql = getSql(c.env);
  const userId = c.get('userId') as string;
  const sinceParam = c.req.query('since');
  const limitParam = c.req.query('limit');
  const since = sinceParam ? Number(sinceParam) : 0;
  const limit = Math.max(1, Math.min(50, limitParam ? Number(limitParam) : 50));

  const rows = await dbAll<CorrectionRow>(
    sql,
    `SELECT ${CORRECTION_SELECT}
       FROM catalog_feedback
      WHERE user_id = $1 AND updated_at > $2
      ORDER BY updated_at ASC, id ASC
      LIMIT $3`,
    [userId, since, limit + 1],
  );
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const cursor = items.length > 0 ? items[items.length - 1].updated_at : since;

  return c.json({
    ok: true,
    data: {
      items: items.map(correctionDTO),
      cursor,
      has_more: hasMore,
    },
  });
});

/** GET /api/catalog/corrections/:correction_id/notified */
catalogRoutes.get('/catalog/corrections/:correction_id/notified', ...mineAuth, async (c) => {
  const sql = getSql(c.env);
  const userId = c.get('userId') as string;
  const correctionId = c.req.param('correction_id');

  const own = await dbGet<{ id: string }>(
    sql,
    `SELECT id FROM catalog_feedback WHERE id = $1 AND user_id = $2`,
    [correctionId, userId],
  );
  if (!own) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'correction not found' } }, 404);
  }

  const rows = await dbAll<{ device_id: string }>(
    sql,
    `SELECT device_id FROM catalog_correction_notifications
      WHERE correction_id = $1`,
    [correctionId],
  );
  return c.json({ ok: true, data: { devices: rows.map((r) => r.device_id) } });
});

const NotifyBody = z.object({ device_id: z.string().min(1).max(128) });

/** POST /api/catalog/corrections/:correction_id/notified */
catalogRoutes.post('/catalog/corrections/:correction_id/notified', ...mineAuth, async (c) => {
  const sql = getSql(c.env);
  const userId = c.get('userId') as string;
  const correctionId = c.req.param('correction_id');

  let parsed: z.infer<typeof NotifyBody>;
  try {
    parsed = NotifyBody.parse(await c.req.json());
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid body';
    return c.json({ ok: false, error: { code: 'bad_request', message } }, 400);
  }

  const own = await dbGet<{ id: string }>(
    sql,
    `SELECT id FROM catalog_feedback WHERE id = $1 AND user_id = $2`,
    [correctionId, userId],
  );
  if (!own) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'correction not found' } }, 404);
  }

  const now = Date.now();
  await dbRun(
    sql,
    `INSERT INTO catalog_correction_notifications (correction_id, device_id, notified_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (correction_id, device_id) DO NOTHING`,
    [correctionId, parsed.device_id, now],
  );
  return c.json({ ok: true, data: { recorded: true } });
});

// Suppress unused-warning for symbols only used internally during the route's
// idempotency-key/dedup paths.
void AUTO_APPLY_FIELDS;
void describeBounds;
