/**
 * Phase 4D · Admin surface.
 *
 * Env-secret header gated (X-Admin-Secret). Single-operator v1 — no
 * RBAC, no admin user table. Used by `admin/corrections.html` (static
 * page in the repo) and by curl smoke tests.
 *
 * Routes:
 *   GET    /admin/corrections                       — list status='reviewed'
 *                                                     + open free-form rows
 *   POST   /admin/corrections/:id/approve           — apply suggestion
 *   POST   /admin/corrections/:id/dismiss           — final dismiss
 *   POST   /api/catalog/:id/revert/:audit_id        — undo any audit row
 *
 * The revert route also accepts the X-Admin-Secret header even though
 * it's mounted under /api — same single-operator gate.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../index';
import { dbAll, dbGet, dbRun } from '../db/helpers';
import { getSql } from '../db/client';

export const adminRoutes = new Hono<AppEnv>();

function gateAdmin(c: { env: { ADMIN_SECRET?: string }; req: { header: (k: string) => string | undefined } }):
  | { ok: true }
  | { ok: false; status: 401 | 503 } {
  const expected = (c.env as { ADMIN_SECRET?: string }).ADMIN_SECRET;
  if (!expected) {
    return { ok: false, status: 503 };
  }
  const provided = c.req.header('X-Admin-Secret') ?? c.req.header('x-admin-secret');
  if (!provided || provided !== expected) {
    return { ok: false, status: 401 };
  }
  return { ok: true };
}

interface ReviewedRow {
  id: string;
  catalog_seed_id: string | null;
  catalog_seed_name: string | null;
  field_name: string | null;
  suggested_value: string | null;
  client_seen_value: string | null;
  body: string | null;
  user_id: string | null;
  status: string;
  ai_review_score: number | null;
  ai_notes: string | null;
  dismissed_reason: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * GET /admin/corrections — lists status='reviewed' rows PLUS open
 * free-form rows (field_name NULL or 'other'). The worker never claims
 * free-form rows, so this list is the only triage path they have.
 */
adminRoutes.get('/admin/corrections', async (c) => {
  const gate = gateAdmin(c);
  if (!gate.ok) {
    return c.json(
      { ok: false, error: { code: gate.status === 401 ? 'unauthorized' : 'not_configured', message: 'admin gate' } },
      gate.status,
    );
  }
  const sql = getSql(c.env);
  const rows = await dbAll<ReviewedRow>(
    sql,
    `SELECT id, catalog_seed_id, catalog_seed_name, field_name, suggested_value,
            client_seen_value, body, user_id, status, ai_review_score, ai_notes,
            dismissed_reason, created_at, updated_at
       FROM catalog_feedback
      WHERE status = 'reviewed'
         OR (status = 'open' AND (field_name IS NULL OR field_name = 'other'))
      ORDER BY updated_at DESC
      LIMIT 200`,
  );
  return c.json({ ok: true, data: { items: rows } });
});

const DismissBody = z.object({ reason: z.string().min(1).max(120) });

/** POST /admin/corrections/:id/approve */
adminRoutes.post('/admin/corrections/:id/approve', async (c) => {
  const gate = gateAdmin(c);
  if (!gate.ok) {
    return c.json(
      { ok: false, error: { code: gate.status === 401 ? 'unauthorized' : 'not_configured', message: 'admin gate' } },
      gate.status,
    );
  }
  const sql = getSql(c.env);
  const id = c.req.param('id');

  const row = await dbGet<ReviewedRow>(
    sql,
    `SELECT id, catalog_seed_id, catalog_seed_name, field_name, suggested_value,
            client_seen_value, body, user_id, status, ai_review_score, ai_notes,
            dismissed_reason, created_at, updated_at
       FROM catalog_feedback
      WHERE id = $1 AND status = 'reviewed'`,
    [id],
  );
  if (!row) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'correction not found or not reviewed' } }, 404);
  }
  if (!row.field_name || !row.suggested_value || !row.catalog_seed_id) {
    return c.json(
      { ok: false, error: { code: 'bad_request', message: 'correction missing required fields' } },
      400,
    );
  }

  const colType = colTypeForField(row.field_name);
  const now = Date.now();
  try {
    await sql.begin(async (tx) => {
      const cur = await tx.unsafe<{ old_value: string | null }[]>(
        `SELECT CAST(${row.field_name} AS TEXT) AS old_value
           FROM catalog_seeds WHERE id = $1`,
        [row.catalog_seed_id],
      );
      const oldValue = cur[0]?.old_value ?? null;
      await tx.unsafe(
        `UPDATE catalog_seeds
            SET ${row.field_name} = $2::${colType}, updated_at = $3
          WHERE id = $1 AND status = 'published'`,
        [row.catalog_seed_id, row.suggested_value, now],
      );
      await tx.unsafe(
        `INSERT INTO catalog_audit_log
           (id, catalog_seed_id, field_name, old_value, new_value, source,
            correction_id, actor_user_id, ai_review_score, created_at)
         VALUES ($1, $2, $3, $4, $5, 'manual_apply', $6, NULL, $7, $8)`,
        [
          `cal_${nanoid(12)}`,
          row.catalog_seed_id,
          row.field_name,
          oldValue,
          row.suggested_value,
          row.id,
          row.ai_review_score,
          now,
        ],
      );
      await tx.unsafe(
        `UPDATE catalog_feedback
            SET status = 'applied', applied_at = $2, reviewed_at = $2, updated_at = $2
          WHERE id = $1`,
        [row.id, now],
      );
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23514') {
      return c.json(
        { ok: false, error: { code: 'cross_field_invariant', message: 'cross-field invariant violation' } },
        409,
      );
    }
    throw err;
  }
  return c.json({ ok: true, data: { id, status: 'applied' } });
});

/** POST /admin/corrections/:id/dismiss */
adminRoutes.post('/admin/corrections/:id/dismiss', async (c) => {
  const gate = gateAdmin(c);
  if (!gate.ok) {
    return c.json(
      { ok: false, error: { code: gate.status === 401 ? 'unauthorized' : 'not_configured', message: 'admin gate' } },
      gate.status,
    );
  }
  const sql = getSql(c.env);
  const id = c.req.param('id');
  let parsed: z.infer<typeof DismissBody>;
  try {
    parsed = DismissBody.parse(await c.req.json());
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid body';
    return c.json({ ok: false, error: { code: 'bad_request', message } }, 400);
  }
  const now = Date.now();
  const result = await dbRun(
    sql,
    `UPDATE catalog_feedback
        SET status = 'dismissed', dismissed_reason = $2,
            reviewed_at = $3, updated_at = $3
      WHERE id = $1 AND status IN ('reviewed', 'open')`,
    [id, parsed.reason, now],
  );
  if (result.meta.changes === 0) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'correction not found' } }, 404);
  }
  return c.json({ ok: true, data: { id, status: 'dismissed' } });
});

/** POST /api/catalog/:id/revert/:audit_id — revert any auto/manual_apply. */
adminRoutes.post('/api/catalog/:id/revert/:audit_id', async (c) => {
  const gate = gateAdmin(c);
  if (!gate.ok) {
    return c.json(
      { ok: false, error: { code: gate.status === 401 ? 'unauthorized' : 'not_configured', message: 'admin gate' } },
      gate.status,
    );
  }
  const sql = getSql(c.env);
  const catalogId = c.req.param('id');
  const auditId = c.req.param('audit_id');

  const audit = await dbGet<{
    id: string;
    catalog_seed_id: string;
    field_name: string;
    old_value: string | null;
    new_value: string | null;
    source: string;
    correction_id: string | null;
  }>(
    sql,
    `SELECT id, catalog_seed_id, field_name, old_value, new_value, source, correction_id
       FROM catalog_audit_log WHERE id = $1 LIMIT 1`,
    [auditId],
  );
  if (!audit) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'audit row not found' } }, 404);
  }
  if (audit.catalog_seed_id !== catalogId) {
    return c.json({ ok: false, error: { code: 'bad_request', message: 'audit row does not belong to this catalog entry' } }, 400);
  }
  if (audit.source === 'manual_revert') {
    return c.json({ ok: false, error: { code: 'already_reverted', message: 'audit row is itself a revert' } }, 409);
  }

  const colType = colTypeForField(audit.field_name);
  const now = Date.now();
  try {
    await sql.begin(async (tx) => {
      if (audit.old_value === null) {
        await tx.unsafe(
          `UPDATE catalog_seeds
              SET ${audit.field_name} = NULL, updated_at = $2
            WHERE id = $1`,
          [audit.catalog_seed_id, now],
        );
      } else {
        await tx.unsafe(
          `UPDATE catalog_seeds
              SET ${audit.field_name} = $2::${colType}, updated_at = $3
            WHERE id = $1`,
          [audit.catalog_seed_id, audit.old_value, now],
        );
      }
      await tx.unsafe(
        `INSERT INTO catalog_audit_log
           (id, catalog_seed_id, field_name, old_value, new_value, source,
            correction_id, actor_user_id, created_at)
         VALUES ($1, $2, $3, $4, $5, 'manual_revert', $6, NULL, $7)`,
        [
          `cal_${nanoid(12)}`,
          audit.catalog_seed_id,
          audit.field_name,
          audit.new_value,
          audit.old_value,
          audit.correction_id,
          now,
        ],
      );
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23514') {
      return c.json(
        { ok: false, error: { code: 'cross_field_invariant', message: 'reverting would violate a cross-field invariant' } },
        409,
      );
    }
    throw err;
  }
  return c.json({ ok: true, data: { catalog_seed_id: catalogId, audit_id: auditId, action: 'reverted' } });
});

function colTypeForField(field: string): string {
  if (field === 'seed_depth_inches') return 'numeric';
  if (
    field === 'sun_requirement' ||
    field === 'frost_tolerance' ||
    field === 'sow_method' ||
    field === 'life_cycle' ||
    field === 'scientific_name' ||
    field === 'common_name' ||
    field === 'variety' ||
    field === 'company' ||
    field === 'instructions'
  ) {
    return 'text';
  }
  return 'integer';
}
