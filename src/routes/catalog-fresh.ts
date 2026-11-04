import { Hono, type Context } from 'hono';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { getSql } from '../db/client';
import { dbAll, dbGet } from '../db/helpers';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { CORRECTABLE_FIELDS, validateFieldValue } from '../lib/catalog/fieldBounds';
import { scrubText } from '../lib/catalog/sanitize';

export const freshCatalogRoutes = new Hono<AppEnv>();
const authOnly = requireAuth();
const ownerAuth = [requireAuth(), requireHousehold()] as const;

const CATALOG_SELECT = `id, barcode, perceptual_hash, common_name, scientific_name, variety, company,
  instructions, viability_years, days_to_germinate_min, days_to_germinate_max,
  days_to_maturity_min, days_to_maturity_max, soil_temp_min_f, soil_temp_max_f,
  seed_depth_inches, plant_spacing_inches, row_spacing_inches, sun_requirement,
  frost_tolerance, sow_method, life_cycle, hardiness_zone_min, hardiness_zone_max,
  status, confidence, created_at, updated_at, published_at`;

function boundedPage(raw: string | undefined, fallback = 50): number | null {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 100 ? n : null;
}

function isOwnerRole(value: string | undefined): boolean { return value === 'owner'; }

freshCatalogRoutes.get('/catalog', authOnly, async (c) => {
  const url = new URL(c.req.url);
  const q = url.searchParams.get('q')?.trim() ?? '';
  const barcode = url.searchParams.get('barcode')?.trim() ?? '';
  const limit = boundedPage(url.searchParams.get('limit') ?? undefined);
  const cursor = url.searchParams.get('cursor');
  if (limit === null || q.length > 120 || barcode.length > 64 || (cursor !== null && (cursor.length < 1 || cursor.length > 128))) {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'Invalid catalog search bounds' } }, 400);
  }
  const params: unknown[] = [];
  const where = ["status = 'published'"];
  if (barcode) { params.push(barcode); where.push(`barcode = $${params.length}`); }
  else if (q) {
    params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(common_name ILIKE $${params.length} ESCAPE '\\' OR variety ILIKE $${params.length} ESCAPE '\\' OR company ILIKE $${params.length} ESCAPE '\\')`);
  }
  if (cursor) { params.push(cursor); where.push(`id > $${params.length}`); }
  params.push(limit + 1);
  const rows = await dbAll<Record<string, unknown>>(getSql(c.env),
    `SELECT ${CATALOG_SELECT} FROM catalog_seeds WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT $${params.length}`,
    params);
  const entries = rows.slice(0, limit);
  return c.json({ ok: true, data: { entries, next_cursor: rows.length > limit ? String(entries.at(-1)?.id) : null } });
});

const packetColumns = [
  'scientific_name','variety','company','instructions','viability_years',
  'days_to_germinate_min','days_to_germinate_max','days_to_maturity_min','days_to_maturity_max',
  'soil_temp_min_f','soil_temp_max_f','seed_depth_inches','plant_spacing_inches','row_spacing_inches',
  'sun_requirement','frost_tolerance','sow_method','life_cycle','hardiness_zone_min','hardiness_zone_max',
] as const;

freshCatalogRoutes.post('/catalog/manual', ...ownerAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(c, 'JSON object required');
  const input = body as Record<string, unknown>;
  const id = input.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || input.confirmed !== true) return badRequest(c, 'A bounded id and confirmed:true are required');
  const cleanName = typeof input.common_name === 'string' ? scrubText(input.common_name) : null;
  if (!cleanName?.ok || cleanName.text.length > 120) return badRequest(c, 'common_name must be non-empty text of at most 120 characters');
  const validatedName = validateFieldValue('common_name', cleanName.text);
  if (!validatedName.ok) return badRequest(c, 'common_name must be non-empty text');
  const packet: Record<string, unknown> = { common_name: validatedName.normalized };
  const columns = ['common_name'];
  for (const key of packetColumns) {
    if (input[key] === undefined || input[key] === null || input[key] === '') continue;
    if (!CORRECTABLE_FIELDS.has(key)) return badRequest(c, `Unsupported field: ${key}`);
    const raw = input[key];
    const validated = (typeof raw === 'number' || typeof raw === 'string') ? validateFieldValue(key, raw) : null;
    if (!validated?.ok) return badRequest(c, `Invalid ${key}`);
    let value: unknown = validated.normalized;
    if (typeof value === 'string') {
      const scrubbed = scrubText(value);
      if (!scrubbed.ok) return badRequest(c, `Invalid ${key}`);
      value = scrubbed.text;
    }
    packet[key] = value;
    columns.push(key);
  }
  if (input.barcode !== undefined && input.barcode !== null && input.barcode !== '') {
    if (typeof input.barcode !== 'string' || !/^[A-Za-z0-9-]{4,64}$/.test(input.barcode)) return badRequest(c, 'Invalid barcode');
    packet.barcode = input.barcode;
    columns.push('barcode');
  }
  // Reject unknown keys to keep retries canonical and prevent silent packet-data loss.
  const accepted = new Set(['id','confirmed','common_name','barcode', ...packetColumns]);
  if (Object.keys(input).some((key) => !accepted.has(key))) return badRequest(c, 'Unsupported packet field');
  if ((typeof packet.days_to_germinate_min === 'number' && typeof packet.days_to_germinate_max === 'number' && packet.days_to_germinate_min > packet.days_to_germinate_max) ||
      (typeof packet.days_to_maturity_min === 'number' && typeof packet.days_to_maturity_max === 'number' && packet.days_to_maturity_min > packet.days_to_maturity_max) ||
      (typeof packet.soil_temp_min_f === 'number' && typeof packet.soil_temp_max_f === 'number' && packet.soil_temp_min_f > packet.soil_temp_max_f) ||
      (typeof packet.hardiness_zone_min === 'number' && typeof packet.hardiness_zone_max === 'number' && packet.hardiness_zone_min > packet.hardiness_zone_max)) {
    return badRequest(c, 'Minimum values cannot exceed maximum values');
  }

  const sql = getSql(c.env);
  const userId = c.get('userId') as string;
  const householdId = c.get('householdId') as string;
  try {
    const result = await sql.begin(async (tx) => {
      const owner = await tx`SELECT m.role FROM memberships m JOIN households h ON h.id=m.household_id
        WHERE m.household_id=${householdId} AND m.user_id=${userId} AND h.deleted_at IS NULL FOR SHARE OF m,h` as unknown as { role: string }[];
      if (!isOwnerRole(owner[0]?.role)) throw Object.assign(new Error('owner_required'), { code: 'owner_required' });
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;
      const prior = await tx`SELECT id, origin_household_id, status FROM catalog_seeds WHERE id = ${id} FOR UPDATE` as unknown as { id: string; origin_household_id: string | null; status: string }[];
      if (prior.length) {
        const audit = await tx`SELECT new_value FROM catalog_audit_log WHERE catalog_seed_id = ${id} AND field_name = '__manual_publication__' AND source = 'manual_apply' LIMIT 1` as unknown as { new_value: string | null }[];
        if (prior[0].origin_household_id !== householdId || prior[0].status !== 'published' || audit[0]?.new_value !== JSON.stringify(packet)) {
          throw Object.assign(new Error('id_conflict'), { code: 'id_conflict' });
        }
        return 'replay';
      }
      const counts = await tx`SELECT
        count(*) FILTER (WHERE created_at >= ${Date.now() - 3_600_000})::int AS hour_count,
        count(*) FILTER (WHERE created_at >= ${Date.now() - 86_400_000})::int AS day_count
        FROM catalog_audit_log WHERE actor_user_id = ${userId} AND field_name = '__manual_publication__'` as unknown as { hour_count: number; day_count: number }[];
      if (Number(counts[0]?.hour_count ?? 0) >= 20 || Number(counts[0]?.day_count ?? 0) >= 5) {
        throw Object.assign(new Error('quota_exceeded'), { code: 'quota_exceeded' });
      }
      const now = Date.now();
      const names = ['id', 'origin_household_id', 'status', 'confidence', 'created_at', 'updated_at', 'published_at', ...columns];
      const vals: unknown[] = [id, householdId, 'published', null, now, now, now, ...columns.map((col) => packet[col])];
      await tx.unsafe(`INSERT INTO catalog_seeds (${names.join(',')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(',')})`, vals as never);
      await tx`INSERT INTO catalog_audit_log (id,catalog_seed_id,field_name,old_value,new_value,source,actor_user_id,created_at)
        VALUES (${`cal_${nanoid(12)}`},${id},'__manual_publication__',NULL,${JSON.stringify(packet)},'manual_apply',${userId},${now})`;
      return 'created';
    });
    const seed = await dbGet<Record<string, unknown>>(sql, `SELECT ${CATALOG_SELECT} FROM catalog_seeds WHERE id = $1`, [id]);
    return c.json({ ok: true, data: { catalog_seed: seed } }, result === 'created' ? 201 : 200);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'owner_required') return forbidden(c);
    if (code === 'id_conflict' || code === '23505') return c.json({ ok: false, error: { code: 'id_conflict', message: 'Catalog id is already used by a different publication' } }, 409);
    if (code === 'quota_exceeded') return c.json({ ok: false, error: { code, message: 'Manual publication limit reached' } }, 429);
    if (code === '23514') return c.json({ ok: false, error: { code: 'invalid_value', message: 'Catalog fields violate bounds or cross-field rules' } }, 400);
    throw err;
  }
});

freshCatalogRoutes.get('/catalog/review-queue', ...ownerAuth, async (c) => {
  const limit = boundedPage(c.req.query('limit'));
  const cursor = c.req.query('cursor');
  if (limit === null || (cursor !== undefined && (cursor.length < 1 || cursor.length > 128))) return badRequest(c, 'Invalid page bounds');
  const sql = getSql(c.env);
  const household = c.get('householdId') as string;
  const cursorClause = cursor ? 'AND cf.id > $2' : '';
  const params = cursor ? [household, cursor, limit + 1] : [household, limit + 1];
  const limitPosition = cursor ? '$3' : '$2';
  const rows = await sql.begin(async (tx) => {
    const owner = await tx`SELECT m.role FROM memberships m JOIN households h ON h.id=m.household_id
      WHERE m.household_id=${household} AND m.user_id=${c.get('userId')} AND h.deleted_at IS NULL FOR SHARE OF m,h` as unknown as { role: string }[];
    if (!isOwnerRole(owner[0]?.role)) throw Object.assign(new Error('owner_required'), { code: 'owner_required' });
    return await tx.unsafe<Record<string, unknown>[]>(
    `SELECT cf.id, cf.catalog_seed_id, cf.catalog_seed_name, cf.field_name, cf.value_type,
            cf.suggested_value, cf.client_seen_value, cf.body, cf.status,
            cf.ai_review_score, cf.ai_notes, cf.dismissed_reason, cf.conflict_with_id,
            cf.user_acknowledged_bounds, cf.created_at, cf.reviewed_at, cf.applied_at,
            cf.escalated_at, cf.updated_at,
            (SELECT al.field_name FROM catalog_audit_log al WHERE al.correction_id = cf.id ORDER BY al.created_at DESC LIMIT 1) AS applied_patch_field_name,
            (SELECT al.new_value FROM catalog_audit_log al WHERE al.correction_id = cf.id ORDER BY al.created_at DESC LIMIT 1) AS applied_patch_new_value,
            CAST(CASE WHEN cf.field_name = 'other' OR cf.field_name IS NULL THEN NULL
                      ELSE to_jsonb(cs)->>cf.field_name END AS TEXT) AS current_value
       FROM catalog_feedback cf JOIN catalog_seeds cs ON cs.id = cf.catalog_seed_id
      JOIN households origin ON origin.id = cs.origin_household_id AND origin.deleted_at IS NULL
      WHERE cs.origin_household_id = $1 AND cf.status IN ('open','reviewed') AND cf.field_name IS NOT NULL
        ${cursorClause} ORDER BY cf.id ASC LIMIT ${limitPosition}`, params as never);
  }).catch((err) => {
    if ((err as { code?: string }).code === 'owner_required') return null;
    throw err;
  });
  if (!rows) return forbidden(c);
  const corrections = rows.slice(0, limit).map((row) => correctionDto(row));
  return c.json({ ok: true, data: { corrections, next_cursor: rows.length > limit ? String(corrections.at(-1)?.id) : null } });
});

freshCatalogRoutes.post('/catalog/:id/corrections/:correctionId/resolve', ...ownerAuth, async (c) => {
  const parsed = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!parsed || typeof parsed.decision !== 'string' || !['apply','dismiss'].includes(parsed.decision) || !(parsed.current_value === null || typeof parsed.current_value === 'string')) return badRequest(c, 'decision and current_value are required');
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const catalogId = c.req.param('id');
  const correctionId = c.req.param('correctionId');
  const decision = parsed.decision as 'apply' | 'dismiss';
  try {
    const outcome = await sql.begin(async (tx) => {
      const owner = await tx`SELECT m.role FROM memberships m JOIN households h ON h.id=m.household_id
        WHERE m.household_id=${householdId} AND m.user_id=${c.get('userId')} AND h.deleted_at IS NULL FOR SHARE OF m,h` as unknown as { role: string }[];
      if (!isOwnerRole(owner[0]?.role)) throw Object.assign(new Error('owner_required'), { code: 'owner_required' });
      const rows = await tx`SELECT cf.id, cf.catalog_seed_id, cf.field_name, cf.suggested_value, cf.status,
          cs.origin_household_id, cs.status AS seed_status,
          CASE WHEN cf.field_name = 'other' OR cf.field_name IS NULL THEN NULL ELSE to_jsonb(cs)->>cf.field_name END AS current_value
        FROM catalog_feedback cf JOIN catalog_seeds cs ON cs.id = cf.catalog_seed_id
        JOIN households origin ON origin.id = cs.origin_household_id AND origin.deleted_at IS NULL
        WHERE cf.id = ${correctionId} AND cf.catalog_seed_id = ${catalogId} FOR UPDATE OF cf, cs` as unknown as { id: string; catalog_seed_id: string; field_name: string | null; suggested_value: string | null; status: string; origin_household_id: string | null; seed_status: string; current_value: string | null }[];
      const row = rows[0];
      if (!row || row.origin_household_id !== householdId || row.seed_status !== 'published') throw Object.assign(new Error('not_found'), { code: 'not_found' });
      if (row.status === 'applied' || row.status === 'dismissed') {
        const same = (decision === 'apply' && row.status === 'applied') || (decision === 'dismiss' && row.status === 'dismissed');
        if (!same) throw Object.assign(new Error('decision_conflict'), { code: 'decision_conflict' });
        const dto = await tx`SELECT cf.id, cf.catalog_seed_id, cf.catalog_seed_name, cf.field_name, cf.value_type,
            cf.suggested_value, cf.client_seen_value, cf.body, cf.status, cf.ai_review_score, cf.ai_notes,
            cf.dismissed_reason, cf.conflict_with_id, cf.user_acknowledged_bounds, cf.created_at,
            cf.reviewed_at, cf.applied_at, cf.escalated_at, cf.updated_at,
            (SELECT al.field_name FROM catalog_audit_log al WHERE al.correction_id = cf.id ORDER BY al.created_at DESC LIMIT 1) AS applied_patch_field_name,
            (SELECT al.new_value FROM catalog_audit_log al WHERE al.correction_id = cf.id ORDER BY al.created_at DESC LIMIT 1) AS applied_patch_new_value
          FROM catalog_feedback cf WHERE cf.id = ${correctionId}`;
        return { replay: true, dto: correctionDto(dto[0] as Record<string, unknown>) };
      }
      if (row.status !== 'open' && row.status !== 'reviewed') throw Object.assign(new Error('not_found'), { code: 'not_found' });
      if (row.current_value !== parsed.current_value) throw Object.assign(new Error('stale'), { code: 'stale' });
      const now = Date.now();
      if (decision === 'dismiss') {
        await tx`UPDATE catalog_feedback SET status='dismissed', dismissed_reason='owner_dismissed', reviewed_at=${now}, updated_at=${now} WHERE id=${correctionId}`;
      } else {
        const field = row.field_name;
        if (!field || !CORRECTABLE_FIELDS.has(field) || row.suggested_value === null) throw Object.assign(new Error('invalid_field'), { code: 'invalid_field' });
        const validated = validateFieldValue(field, row.suggested_value);
        if (!validated.ok) throw Object.assign(new Error('invalid_value'), { code: 'invalid_value' });
        let normalized = String(validated.normalized);
        if (typeof validated.normalized === 'string') {
          const sanitized = scrubText(validated.normalized);
          if (!sanitized.ok) throw Object.assign(new Error('invalid_value'), { code: 'invalid_value' });
          normalized = sanitized.text;
        }
        const sqlType = field === 'seed_depth_inches' ? 'numeric' : ['sun_requirement','frost_tolerance','sow_method','life_cycle','scientific_name','common_name','variety','company','instructions'].includes(field) ? 'text' : 'integer';
        await tx.unsafe(`UPDATE catalog_seeds SET ${field} = $2::${sqlType}, updated_at = $3 WHERE id = $1 AND status='published'`, [catalogId, normalized, now]);
        await tx`INSERT INTO catalog_audit_log (id,catalog_seed_id,field_name,old_value,new_value,source,correction_id,actor_user_id,created_at)
          VALUES (${`cal_${nanoid(12)}`},${catalogId},${field},${row.current_value},${normalized},'manual_apply',${correctionId},${c.get('userId')},${now})`;
        await tx`UPDATE catalog_feedback SET status='applied', applied_at=${now}, reviewed_at=${now}, updated_at=${now} WHERE id=${correctionId}`;
        await tx`DELETE FROM recommendation_cache WHERE catalog_seed_id=${catalogId}`;
      }
      const dto = await tx`SELECT cf.id, cf.catalog_seed_id, cf.catalog_seed_name, cf.field_name, cf.value_type,
          cf.suggested_value, cf.client_seen_value, cf.body, cf.status, cf.ai_review_score, cf.ai_notes,
          cf.dismissed_reason, cf.conflict_with_id, cf.user_acknowledged_bounds, cf.created_at,
          cf.reviewed_at, cf.applied_at, cf.escalated_at, cf.updated_at,
          (SELECT al.field_name FROM catalog_audit_log al WHERE al.correction_id = cf.id ORDER BY al.created_at DESC LIMIT 1) AS applied_patch_field_name,
          (SELECT al.new_value FROM catalog_audit_log al WHERE al.correction_id = cf.id ORDER BY al.created_at DESC LIMIT 1) AS applied_patch_new_value
        FROM catalog_feedback cf WHERE cf.id = ${correctionId}`;
      return { replay: false, dto: correctionDto(dto[0] as Record<string, unknown>) };
    });
    return c.json({ ok: true, data: { correction: outcome.dto } });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'owner_required') return forbidden(c);
    if (code === 'not_found') return c.json({ ok: false, error: { code, message: 'Correction not found for selected origin garden' } }, 404);
    if (code === 'stale' || code === 'decision_conflict') return c.json({ ok: false, error: { code, message: 'Correction changed; refresh before resolving' } }, 409);
    if (code === 'invalid_field' || code === 'invalid_value' || (err as { code?: string }).code === '23514') return c.json({ ok: false, error: { code: 'invalid_value', message: 'Correction violates catalog field bounds or invariants' } }, 400);
    throw err;
  }
});

function correctionDto(row: Record<string, unknown>): Record<string, unknown> {
  const { applied_patch_field_name: field, applied_patch_new_value: value, ...dto } = row;
  return {
    ...dto,
    user_acknowledged_bounds: Boolean(dto.user_acknowledged_bounds),
    applied_patch: dto.status === 'applied' && field != null && value != null
      ? { field_name: field, new_value: value } : null,
  };
}

function badRequest(c: Context<AppEnv>, message: string) {
  return c.json({ ok: false, error: { code: 'bad_request', message } }, 400);
}

function forbidden(c: Context<AppEnv>) {
  return c.json({ ok: false, error: { code: 'forbidden', message: 'Only an owner of the selected origin garden may perform this action' } }, 403);
}
