import { Hono } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { dbGet, dbRun } from '../db/helpers';
import { getSql } from '../db/client';
import type { Sql } from 'postgres';
import { isAllowedMime, newPhotoKey, putPhoto } from '../lib/storage';
import { extractFromPhotos, type ExtractionResult } from '../lib/extraction/anthropic';
import { reviewExtraction } from '../lib/extraction/review';
import { decideCatalogStatus, type CatalogDecision } from '../lib/extraction/confidence';
import { checkRateLimit } from '../lib/rateLimit';

// 20 pre-extracted submissions per user per hour.
const PRE_EXTRACTED_LIMIT = 20;
const PRE_EXTRACTED_WINDOW_MS = 3_600_000;

type UserTier = 'free' | 'byok' | 'hosted';

async function loadUserTier(sql: Sql, userId: string): Promise<UserTier> {
  const row = await dbGet<{ tier: UserTier }>(
    sql,
    `SELECT tier FROM "user" WHERE id = $1 LIMIT 1`,
    [userId],
  );
  return row?.tier ?? 'free';
}

export const extractionRoutes = new Hono<AppEnv>();

const auth = [requireAuth(), requireHousehold()] as const;

interface ExtractionRow {
  id: string;
  catalog_seed_id: string | null;
  status: 'pending' | 'reviewed' | 'failed';
  raw_extraction: string;
  review_score: number | null;
  review_notes: string | null;
  source_photo_keys: string;
  created_at: number;
  reviewed_at: number | null;
}

const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5MB per side; iOS resizes before upload

async function readImagePart(form: FormData, field: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const part = form.get(field);
  if (part === null || typeof part === 'string') return null;
  const file = part as Blob & { name?: string };
  if (!isAllowedMime(file.type)) return null;
  if (file.size > MAX_PHOTO_BYTES) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { bytes, mime: file.type };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function persistDecision(
  sql: Sql,
  catalogSeedId: string,
  decision: CatalogDecision,
  extraction: ExtractionResult,
  barcode: string | null,
  perceptualHash: string | null,
  reviewScore: number,
  originHouseholdId: string,
  now: number,
): Promise<void> {
  const status = decision.status === 'published' ? 'published'
               : decision.status === 'rejected' ? 'rejected'
               : 'pending';
  const publishedAt = status === 'published' ? now : null;

  await dbRun(
    sql,
    `INSERT INTO catalog_seeds (
       id, barcode, perceptual_hash, common_name, scientific_name, variety, company,
       instructions, viability_years,
       days_to_germinate_min, days_to_germinate_max,
       days_to_maturity_min, days_to_maturity_max,
       soil_temp_min_f, soil_temp_max_f,
       seed_depth_inches, plant_spacing_inches, row_spacing_inches,
       sun_requirement, frost_tolerance, sow_method, life_cycle,
       hardiness_zone_min, hardiness_zone_max,
       status, confidence, origin_household_id,
       created_at, updated_at, published_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9,
       $10, $11,
       $12, $13,
       $14, $15,
       $16, $17, $18,
       $19, $20, $21, $22,
       $23, $24,
       $25, $26, $27,
       $28, $29, $30
     )`,
    [
      catalogSeedId, barcode, perceptualHash,
      extraction.common_name ?? '(unknown)',
      extraction.scientific_name,
      extraction.variety, extraction.company,
      extraction.instructions, null,
      extraction.days_to_germinate_min, extraction.days_to_germinate_max,
      extraction.days_to_maturity_min, extraction.days_to_maturity_max,
      extraction.soil_temp_min_f, extraction.soil_temp_max_f,
      extraction.seed_depth_inches, extraction.plant_spacing_inches, extraction.row_spacing_inches,
      extraction.sun_requirement, extraction.frost_tolerance, extraction.sow_method, extraction.life_cycle,
      extraction.hardiness_zone_min, extraction.hardiness_zone_max,
      status, reviewScore, originHouseholdId,
      now, now, publishedAt,
    ],
  );
}

/**
 * POST /api/extractions
 *
 * multipart/form-data:
 *   front: image/jpeg|png|heic
 *   back:  image/jpeg|png|heic
 *   barcode?: string         optional UPC/EAN if the camera saw one
 *   perceptual_hash?: string optional client-computed pHash
 *
 * Phase 1 runs synchronously: Anthropic vision + reviewer pass take
 * ~10–15s end-to-end. Hosted-tier users hit this path; free/byok users
 * will hit a future "pre-extracted" route in F2.
 *
 * Returns the persisted extraction + the catalog decision.
 */
extractionRoutes.post('/extractions', ...auth, async (c) => {
  const userId = c.get('userId');
  const householdId = c.get('householdId');
  const sql = getSql(c.env);

  // Tier gate: only `hosted` users may run server-side vision. Free and
  // BYOK users go through `/api/extractions/pre-extracted` with their
  // on-device or own-key extraction result.
  const tier = await loadUserTier(sql, userId);
  if (tier !== 'hosted') {
    return c.json(
      {
        ok: false,
        error: {
          code: 'wrong_tier',
          message: `Server-side extraction is only available on the hosted tier (current tier: ${tier}). Use /api/extractions/pre-extracted from the iOS client.`,
        },
      },
      402,
    );
  }

  const apiKey = c.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json(
      { ok: false, error: { code: 'not_configured', message: 'ANTHROPIC_API_KEY is not configured' } },
      503,
    );
  }

  const form = await c.req.formData().catch(() => null);
  if (!form) {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'Expected multipart/form-data' } }, 400);
  }

  const front = await readImagePart(form, 'front');
  const back = await readImagePart(form, 'back');
  if (!front || !back) {
    return c.json(
      { ok: false, error: { code: 'bad_request', message: 'front and back image fields are required (jpeg/png/heic, <=5MB)' } },
      400,
    );
  }

  const barcode = (form.get('barcode') as string | null)?.trim() || null;
  const perceptualHash = (form.get('perceptual_hash') as string | null)?.trim() || null;

  const extractionId = nanoid();
  const now = Date.now();

  // Upload both images to S3 first so we always have the originals,
  // even if vision fails.
  const frontKey = newPhotoKey({ householdId, scope: 'extractions', ownerId: extractionId, role: 'front' });
  const backKey = newPhotoKey({ householdId, scope: 'extractions', ownerId: extractionId, role: 'back' });
  await putPhoto(c.env, frontKey, front.bytes, front.mime);
  await putPhoto(c.env, backKey, back.bytes, back.mime);

  // Insert the extraction row in pending state up-front so we have a
  // durable record even if the vision call hangs or fails.
  await dbRun(
    sql,
    `INSERT INTO catalog_extractions (
       id, submitted_by_household, submitted_by_user, vision_model_id,
       raw_extraction, source_photo_keys, status, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
    [
      extractionId, householdId, userId, c.env.DEFAULT_VISION_MODEL,
      JSON.stringify({ pending: true }),
      JSON.stringify([frontKey, backKey]),
      now,
    ],
  );

  let extraction: ExtractionResult;
  let visionRaw: unknown;
  try {
    const out = await extractFromPhotos({
      apiKey,
      model: c.env.DEFAULT_VISION_MODEL,
      frontBase64: bytesToBase64(front.bytes),
      backBase64: bytesToBase64(back.bytes),
    });
    extraction = out.result;
    visionRaw = out.raw;
  } catch (err) {
    await dbRun(
      sql,
      `UPDATE catalog_extractions
          SET status = 'failed',
              raw_extraction = $1,
              reviewed_at = $2
        WHERE id = $3`,
      [JSON.stringify({ error: String(err) }), Date.now(), extractionId],
    );
    return c.json(
      { ok: false, error: { code: 'vision_failed', message: 'Vision extraction failed' } },
      502,
    );
  }

  let reviewScore = 0;
  let reviewNotes = '';
  let reviewRaw: unknown = null;
  try {
    const out = await reviewExtraction({
      apiKey,
      model: c.env.DEFAULT_REVIEW_MODEL,
      extraction,
    });
    reviewScore = out.review.score;
    reviewNotes = out.review.notes;
    reviewRaw = out.raw;
  } catch (err) {
    reviewNotes = `reviewer error: ${String(err)}`;
  }

  const decision = decideCatalogStatus({
    selfConfidence: extraction.self_confidence,
    reviewScore,
    extraction,
  });

  let catalogSeedId: string | null = null;
  if (decision.status !== 'rejected') {
    catalogSeedId = nanoid();
    await persistDecision(
      sql, catalogSeedId, decision, extraction,
      barcode, perceptualHash, reviewScore, householdId, Date.now(),
    );
  }

  const reviewedAt = Date.now();
  await dbRun(
    sql,
    `UPDATE catalog_extractions
        SET catalog_seed_id = $1,
            raw_extraction = $2,
            review_model_id = $3,
            review_score = $4,
            review_notes = $5,
            status = 'reviewed',
            reviewed_at = $6
      WHERE id = $7`,
    [
      catalogSeedId,
      JSON.stringify({ extraction, vision_raw: visionRaw, review_raw: reviewRaw }),
      c.env.DEFAULT_REVIEW_MODEL,
      reviewScore,
      reviewNotes,
      reviewedAt,
      extractionId,
    ],
  );

  return c.json({
    ok: true,
    data: {
      extraction_id: extractionId,
      catalog_seed_id: catalogSeedId,
      decision,
      extraction,
      review: { score: reviewScore, notes: reviewNotes },
      photo_keys: { front: frontKey, back: backKey },
    },
  });
});

/**
 * POST /api/extractions/pre-extracted
 *
 * For free + byok tiers — the client extracts on-device (Apple
 * Foundation Models, OpenAI, Anthropic, etc.) and posts the result
 * along with optional packet photos. The server runs no LLM call:
 * it just persists the extraction, applies the catalog decision based
 * on the client-supplied `self_confidence`, and (when confidence
 * clears the bar) inserts a `catalog_seeds` row for the global catalog.
 *
 * Body: JSON
 * ```
 * {
 *   "common_name": string | null,
 *   "variety": string | null,
 *   "company": string | null,
 *   "instructions": string | null,
 *   "self_confidence": number,            // 0..1, client's own rating
 *   "model_id": string,                   // e.g. "apple.foundation.v1", "openai.gpt-4o", "anthropic.claude-sonnet-4-6"
 *   "barcode"?: string,                   // optional UPC/EAN
 *   "perceptual_hash"?: string,           // optional client-side pHash
 *   "front_jpeg_b64"?: string,            // optional base64 packet photos
 *   "back_jpeg_b64"?: string
 * }
 * ```
 */
const preExtractedSchema = z.object({
  // .nullish() == .nullable().optional() — accepts null, undefined, or a
  // missing key. Swift's default JSONEncoder omits nil-valued Optional
  // keys entirely, so .nullable() (which requires the key be present)
  // breaks any extractor that returns nil for these fields.
  common_name: z.string().trim().max(120).nullish(),
  scientific_name: z.string().trim().max(120).nullish(),
  variety: z.string().trim().max(120).nullish(),
  company: z.string().trim().max(120).nullish(),
  instructions: z.string().trim().max(4000).nullish(),
  // Horticultural data — all optional, all nullable; the on-device + BYOK
  // extractors fill in whatever the packet shows.
  days_to_germinate_min: z.number().int().min(0).max(365).nullable().optional(),
  days_to_germinate_max: z.number().int().min(0).max(365).nullable().optional(),
  days_to_maturity_min: z.number().int().min(0).max(720).nullable().optional(),
  days_to_maturity_max: z.number().int().min(0).max(720).nullable().optional(),
  soil_temp_min_f: z.number().int().min(0).max(120).nullable().optional(),
  soil_temp_max_f: z.number().int().min(0).max(120).nullable().optional(),
  seed_depth_inches: z.number().min(0).max(12).nullable().optional(),
  plant_spacing_inches: z.number().int().min(0).max(240).nullable().optional(),
  row_spacing_inches: z.number().int().min(0).max(240).nullable().optional(),
  sun_requirement: z.enum(['full', 'partial', 'shade']).nullable().optional(),
  frost_tolerance: z.enum(['tender', 'half_hardy', 'hardy']).nullable().optional(),
  sow_method: z.enum(['direct', 'transplant', 'either']).nullable().optional(),
  life_cycle: z.enum(['annual', 'biennial', 'perennial']).nullable().optional(),
  hardiness_zone_min: z.number().int().min(1).max(13).nullable().optional(),
  hardiness_zone_max: z.number().int().min(1).max(13).nullable().optional(),

  self_confidence: z.number().min(0).max(1),
  model_id: z.string().trim().min(1).max(100),
  barcode: z.string().trim().max(40).optional(),
  perceptual_hash: z.string().trim().max(80).optional(),
  front_jpeg_b64: z.string().optional(),
  back_jpeg_b64: z.string().optional(),
});

extractionRoutes.post('/extractions/pre-extracted', ...auth, async (c) => {
  const userId = c.get('userId');
  const householdId = c.get('householdId');
  const sql = getSql(c.env);

  // Free or BYOK only — hosted users get the server-side vision path.
  const tier = await loadUserTier(sql, userId);
  if (tier === 'hosted') {
    return c.json(
      {
        ok: false,
        error: {
          code: 'wrong_tier',
          message: 'Hosted-tier users should POST /api/extractions for server-side vision.',
        },
      },
      400,
    );
  }

  const rl = await checkRateLimit(sql, {
    scopeId: userId,
    scopeColumn: 'submitted_by_user',
    table: 'catalog_extractions',
    windowMs: PRE_EXTRACTED_WINDOW_MS,
    limit: PRE_EXTRACTED_LIMIT,
    retryAfterSeconds: 3600,
    message: 'too many extractions in the last hour',
  });
  if (rl.limited) return c.json(rl.response, 429);

  const body = await c.req.json().catch(() => null);
  const parsed = preExtractedSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: { code: 'bad_request', message: parsed.error.message } }, 400);
  }
  const input = parsed.data;

  const extractionId = nanoid();
  const now = Date.now();

  // Upload optional packet photos to S3. Photos let us re-extract / curate
  // the catalog later. Skipping them is allowed but not recommended.
  const photoKeys: string[] = [];
  if (input.front_jpeg_b64) {
    const front = decodeBase64(input.front_jpeg_b64);
    if (front) {
      const key = newPhotoKey({ householdId, scope: 'extractions', ownerId: extractionId, role: 'front' });
      await putPhoto(c.env, key, front, 'image/jpeg');
      photoKeys.push(key);
    }
  }
  if (input.back_jpeg_b64) {
    const back = decodeBase64(input.back_jpeg_b64);
    if (back) {
      const key = newPhotoKey({ householdId, scope: 'extractions', ownerId: extractionId, role: 'back' });
      await putPhoto(c.env, key, back, 'image/jpeg');
      photoKeys.push(key);
    }
  }

  // Build the extraction shape the rest of the pipeline expects.
  // Coalesce undefined → null because .nullish() schema fields are typed
  // `string | null | undefined` but ExtractionResult takes `string | null`.
  const extraction: ExtractionResult = {
    common_name: input.common_name ?? null,
    scientific_name: input.scientific_name ?? null,
    variety: input.variety ?? null,
    company: input.company ?? null,
    instructions: input.instructions ?? null,
    days_to_germinate_min: input.days_to_germinate_min ?? null,
    days_to_germinate_max: input.days_to_germinate_max ?? null,
    days_to_maturity_min: input.days_to_maturity_min ?? null,
    days_to_maturity_max: input.days_to_maturity_max ?? null,
    soil_temp_min_f: input.soil_temp_min_f ?? null,
    soil_temp_max_f: input.soil_temp_max_f ?? null,
    seed_depth_inches: input.seed_depth_inches ?? null,
    plant_spacing_inches: input.plant_spacing_inches ?? null,
    row_spacing_inches: input.row_spacing_inches ?? null,
    sun_requirement: input.sun_requirement ?? null,
    frost_tolerance: input.frost_tolerance ?? null,
    sow_method: input.sow_method ?? null,
    life_cycle: input.life_cycle ?? null,
    hardiness_zone_min: input.hardiness_zone_min ?? null,
    hardiness_zone_max: input.hardiness_zone_max ?? null,
    self_confidence: input.self_confidence,
  };

  // Pre-extracted submissions skip the server-side reviewer pass — the
  // client is trusted to self-rate. We feed `self_confidence` in as the
  // review score for the policy decision so the same `decideCatalogStatus`
  // gate applies. Future hardening: run a cheap reviewer pass for
  // submissions whose `self_confidence` is borderline.
  const decision = decideCatalogStatus({
    selfConfidence: input.self_confidence,
    reviewScore: input.self_confidence,
    extraction,
  });

  let catalogSeedId: string | null = null;
  if (decision.status !== 'rejected') {
    catalogSeedId = nanoid();
    await persistDecision(
      sql, catalogSeedId, decision, extraction,
      input.barcode ?? null, input.perceptual_hash ?? null,
      input.self_confidence, householdId, now,
    );
  }

  // Always persist the catalog_extractions row for audit + future re-review.
  await dbRun(
    sql,
    `INSERT INTO catalog_extractions (
       id, catalog_seed_id, submitted_by_household, submitted_by_user,
       vision_model_id, raw_extraction, source_photo_keys, status,
       review_score, review_notes, created_at, reviewed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'reviewed', $8, $9, $10, $11)`,
    [
      extractionId,
      catalogSeedId,
      householdId,
      userId,
      input.model_id,
      JSON.stringify({ extraction, source: 'client_pre_extracted' }),
      JSON.stringify(photoKeys),
      input.self_confidence,
      `client self-confidence ${input.self_confidence.toFixed(2)} (no server review)`,
      now,
      now,
    ],
  );

  return c.json({
    ok: true,
    data: {
      extraction_id: extractionId,
      catalog_seed_id: catalogSeedId,
      decision,
      extraction,
      review: {
        score: input.self_confidence,
        notes: 'pre-extracted: self_confidence used as proxy',
      },
      photo_keys: photoKeys,
    },
  });
});

function decodeBase64(b64: string): Uint8Array | null {
  try {
    const cleaned = b64.replace(/^data:[^;]+;base64,/, '');
    const bin = atob(cleaned);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * GET /api/extractions/:id — fetch the saved extraction.
 */
extractionRoutes.get('/extractions/:id', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const id = c.req.param('id');
  const sql = getSql(c.env);
  const row = await dbGet<ExtractionRow>(
    sql,
    `SELECT id, catalog_seed_id, status, raw_extraction,
            review_score, review_notes, source_photo_keys,
            created_at, reviewed_at
       FROM catalog_extractions
      WHERE id = $1 AND submitted_by_household = $2
      LIMIT 1`,
    [id, householdId],
  );
  if (!row) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Extraction not found' } }, 404);
  }
  return c.json({ ok: true, data: { extraction: row } });
});
