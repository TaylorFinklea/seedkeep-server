import { Hono } from 'hono';
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
       id, barcode, perceptual_hash, common_name, variety, company,
       instructions, viability_years, status, confidence,
       origin_household_id, created_at, updated_at, published_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      catalogSeedId, barcode, perceptualHash,
      extraction.common_name ?? '(unknown)',
      extraction.variety, extraction.company,
      extraction.instructions, null,
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
