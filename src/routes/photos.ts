import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { dbAll, dbGet, dbRun, isUniqueViolation } from '../db/helpers';
import { getSql } from '../db/client';
import { deletePhoto, getPhoto, isAllowedMime, newPhotoKey, putPhoto } from '../lib/storage';
import { checkRateLimit } from '../lib/rateLimit';
import { setVersionHeader } from '../lib/versioning';

// 20 photo uploads per household per hour.
const PHOTO_UPLOAD_LIMIT = 20;
const PHOTO_UPLOAD_WINDOW_MS = 3_600_000;

export const photoRoutes = new Hono<AppEnv>();

const auth = [requireAuth(), requireHousehold()] as const;

const ALLOWED_ROLES = ['front', 'back', 'extra'] as const;
type PhotoRole = typeof ALLOWED_ROLES[number];

// 10 MB ceiling on photo uploads. Seed packets compress well under 1MB
// after the iOS resize; this cap is the abuse-prevention guardrail.
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

interface PhotoRow {
  id: string;
  seed_id: string;
  household_id: string;
  r2_key: string;
  role: PhotoRole;
  width: number | null;
  height: number | null;
  byte_size: number | null;
  captured_at: number;
}

/**
 * POST /api/seeds/:seedId/photos
 *
 * Body: raw image bytes (Content-Type: image/jpeg|image/png|image/heic).
 * Query: ?role=front|back|extra (default extra).
 *
 * Direct-to-server upload — packets compress to under 1MB and the savings
 * from presigned URLs aren't worth the AWS-SigV4 dependency. Reach for
 * presigning if upload latency becomes a problem.
 */
photoRoutes.post('/seeds/:seedId/photos', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const seedId = c.req.param('seedId');
  const sql = getSql(c.env);

  const requestedId = c.req.query('id');
  if (requestedId !== undefined && (requestedId.length < 1 || requestedId.length > 80)) {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'id must be 1 to 80 characters' } }, 400);
  }

  if (requestedId) {
    const replay = await dbGet<PhotoRow>(sql,
      `SELECT id, seed_id, household_id, r2_key, role, width, height, byte_size, captured_at FROM seed_photos WHERE id = $1 AND household_id = $2`, [requestedId, householdId]);
    if (replay) {
      const owner = await dbGet<{ version: number }>(sql, `SELECT version FROM seeds WHERE id = $1 AND household_id = $2`, [replay.seed_id, householdId]);
      if (owner) setVersionHeader(c, owner.version);
      return c.json({ ok: true, data: { photo: replay } });
    }
    const occupied = await dbGet<{ id: string }>(sql, `SELECT id FROM seed_photos WHERE id = $1`, [requestedId]);
    if (occupied) return c.json({ ok: false, error: { code: 'conflict', message: 'A record with this id already exists.' } }, 409);
  }

  const rl = await checkRateLimit(sql, {
    scopeId: householdId, scopeColumn: 'household_id', table: 'seed_photos',
    createdAtColumn: 'captured_at', windowMs: PHOTO_UPLOAD_WINDOW_MS,
    limit: PHOTO_UPLOAD_LIMIT, retryAfterSeconds: 3600,
    message: 'too many photo uploads in the last hour',
  });
  if (rl.limited) return c.json(rl.response, 429);

  const seed = await dbGet<{ id: string }>(
    sql,
    `SELECT id FROM seeds WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [seedId, householdId],
  );
  if (!seed) {
    return c.json({ ok: false, error: { code: 'invalid_reference', message: 'Seed does not exist in this household.' } }, 400);
  }

  const roleParam = (c.req.query('role') ?? 'extra') as PhotoRole;
  if (!ALLOWED_ROLES.includes(roleParam)) {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'role must be front|back|extra' } }, 400);
  }

  const mime = c.req.header('Content-Type');
  if (!isAllowedMime(mime)) {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'Unsupported Content-Type' } }, 400);
  }

  // Cap before consuming the body — packets compress to under 1MB and
  // we don't want a buggy or hostile client OOMing the Fly machine.
  // The Content-Length header may lie, so we still cap after reading.
  const declaredLength = Number(c.req.header('Content-Length') ?? '0');
  if (declaredLength > MAX_PHOTO_BYTES) {
    return c.json({ ok: false, error: { code: 'payload_too_large',
      message: `Photo too large (${declaredLength} bytes). Max ${MAX_PHOTO_BYTES}.` } }, 413);
  }
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'Empty body' } }, 400);
  }
  if (body.byteLength > MAX_PHOTO_BYTES) {
    return c.json({ ok: false, error: { code: 'payload_too_large',
      message: `Photo too large (${body.byteLength} bytes). Max ${MAX_PHOTO_BYTES}.` } }, 413);
  }

  const key = newPhotoKey({ householdId, scope: 'seeds', ownerId: seedId, role: roleParam });

  const id = requestedId ?? nanoid();
  const now = Date.now();
  let racedReplay: PhotoRow | null = null;
  let parentVersion: number;
  try {
  parentVersion = await sql.begin(async (tx) => {
    const parent = await dbGet<{ id: string; version: number }>(tx,
      `SELECT id, version FROM seeds WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR SHARE`, [seedId, householdId]);
    if (!parent) throw new Error('SEED_NOT_FOUND');
    const collision = await dbGet<{ id: string; household_id: string }>(tx, `SELECT id, household_id FROM seed_photos WHERE id = $1`, [id]);
    if (collision) throw new Error(collision.household_id === householdId ? 'SEED_PHOTO_REPLAY_RACE' : 'SEED_PHOTO_CONFLICT');
    await putPhoto(c.env, key, body, mime!);
    await dbRun(tx, `INSERT INTO seed_photos (id, seed_id, household_id, r2_key, role, byte_size, captured_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, seedId, householdId, key, roleParam, body.byteLength, now]);
    const bumped = await tx.unsafe<{ version: number }[]>(`UPDATE seeds SET updated_at = $1, version = version + 1
      WHERE id = $2 AND household_id = $3 RETURNING version`, [now, seedId, householdId]);
    return bumped[0]!.version;
  });
  } catch (err) {
    if (err instanceof Error && err.message === 'SEED_PHOTO_REPLAY_RACE') {
      await deletePhoto(c.env, key).catch(() => {});
      racedReplay = await dbGet<PhotoRow>(sql, `SELECT id, seed_id, household_id, r2_key, role, width, height, byte_size, captured_at FROM seed_photos WHERE id = $1 AND household_id = $2`, [id, householdId]);
      if (racedReplay) {
        const owner = await dbGet<{ version: number }>(sql, `SELECT version FROM seeds WHERE id = $1 AND household_id = $2`, [racedReplay.seed_id, householdId]);
        if (owner) setVersionHeader(c, owner.version);
        return c.json({ ok: true, data: { photo: racedReplay } });
      }
      return c.json({ ok: false, error: { code: 'conflict', message: 'A record with this id already exists.' } }, 409);
    }
    if (isUniqueViolation(err)) {
      await deletePhoto(c.env, key).catch(() => {});
      racedReplay = await dbGet<PhotoRow>(sql, `SELECT id, seed_id, household_id, r2_key, role, width, height, byte_size, captured_at FROM seed_photos WHERE id = $1 AND household_id = $2`, [id, householdId]);
      if (!racedReplay) return c.json({ ok: false, error: { code: 'conflict', message: 'A record with this id already exists.' } }, 409);
      const owner = await dbGet<{ version: number }>(sql, `SELECT version FROM seeds WHERE id = $1 AND household_id = $2`, [racedReplay.seed_id, householdId]);
      if (owner) setVersionHeader(c, owner.version);
      return c.json({ ok: true, data: { photo: racedReplay } });
    }
    if (err instanceof Error && err.message === 'SEED_PHOTO_CONFLICT') return c.json({ ok: false, error: { code: 'conflict', message: 'A record with this id already exists.' } }, 409);
    if (err instanceof Error && err.message === 'SEED_NOT_FOUND') return c.json({ ok: false, error: { code: 'invalid_reference', message: 'Seed does not exist in this household.' } }, 400);
    throw err;
  }
  setVersionHeader(c, parentVersion);

  return c.json({
    ok: true,
    data: {
      photo: {
        id,
        seed_id: seedId,
        household_id: householdId,
        r2_key: key,
        role: roleParam,
        width: null,
        height: null,
        byte_size: body.byteLength,
        captured_at: now,
      },
    },
  });
});

/**
 * GET /api/seeds/:seedId/photos — list photos for a seed.
 */
photoRoutes.get('/seeds/:seedId/photos', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const seedId = c.req.param('seedId');
  const sql = getSql(c.env);
  const photos = await dbAll<PhotoRow>(
    sql,
    `SELECT id, seed_id, household_id, r2_key, role, width, height, byte_size, captured_at
       FROM seed_photos WHERE seed_id = $1 AND household_id = $2 ORDER BY captured_at ASC`,
    [seedId, householdId],
  );
  return c.json({ ok: true, data: { photos } });
});

/**
 * GET /api/photos/:photoId — fetch the binary. The route stays inside the
 * household-scoped router so we authorize before serving bytes.
 */
photoRoutes.get('/photos/:photoId', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const photoId = c.req.param('photoId');
  const sql = getSql(c.env);
  const photo = await dbGet<PhotoRow>(
    sql,
    `SELECT id, seed_id, household_id, r2_key, role, width, height, byte_size, captured_at
       FROM seed_photos WHERE id = $1 AND household_id = $2 LIMIT 1`,
    [photoId, householdId],
  );
  if (!photo) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Photo not found' } }, 404);
  }
  const obj = await getPhoto(c.env, photo.r2_key);
  if (!obj) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Photo missing in storage' } }, 404);
  }
  return new Response(obj.bytes, {
    headers: {
      'Content-Type': obj.contentType,
      'Cache-Control': 'private, max-age=3600',
    },
  });
});

/**
 * DELETE /api/photos/:photoId
 */
photoRoutes.delete('/photos/:photoId', ...auth, async (c) => {
  const householdId = c.get('householdId');
  const photoId = c.req.param('photoId');
  const sql = getSql(c.env);
  const result = await sql.begin(async (tx) => {
    const snapshot = await dbGet<{ seed_id: string }>(tx,
      `SELECT seed_id FROM seed_photos WHERE id = $1 AND household_id = $2`, [photoId, householdId]);
    if (!snapshot) return null;
    await dbGet(tx, `SELECT id FROM seeds WHERE id = $1 AND household_id = $2 FOR UPDATE`, [snapshot.seed_id, householdId]);
    const photo = await dbGet<PhotoRow>(tx,
      `SELECT id, seed_id, household_id, r2_key, role, width, height, byte_size, captured_at FROM seed_photos WHERE id = $1 AND household_id = $2 FOR UPDATE`, [photoId, householdId]);
    if (!photo) return null;
    await dbRun(tx, `DELETE FROM seed_photos WHERE id = $1 AND household_id = $2`, [photoId, householdId]);
    const rows = await tx.unsafe<{ version: number }[]>(`UPDATE seeds SET updated_at = $1, version = version + 1
      WHERE id = $2 AND household_id = $3 RETURNING version`, [Date.now(), photo.seed_id, householdId]);
    return { photo, version: rows[0]?.version ?? null };
  });
  if (!result) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Photo not found' } }, 404);
  }
  await deletePhoto(c.env, result.photo.r2_key).catch(() => {});
  if (result.version !== null) setVersionHeader(c, result.version);
  return c.json({ ok: true, data: { id: photoId, deleted: true } });
});
