import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../index';
import { getSql } from '../db/client';
import { dbGet, dbRun } from '../db/helpers';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';

/**
 * Watering-state ledger — Phase 4C cross-device dedup for watering reminders.
 *
 * Frost + heat warnings stay per-device (date-anchored ids coincide naturally
 * across the same iCloud account). Watering is duration-anchored, so two
 * devices fielding a fresh "5 dry days" trigger one second apart would each
 * fire absent a shared store. `households.last_watering_notification_at` is
 * that store; `GREATEST(COALESCE(existing, $2), $2)` keeps progression
 * monotonic even when two devices POST concurrently — PostgreSQL serializes
 * the UPDATEs and the larger timestamp wins.
 *
 * Mirrors the `journal.ts` auth + envelope shape: per-route auth tuple,
 * `dbGet`/`dbRun` with `$N` params, `{ ok, data }` envelope.
 */

const auth = [requireAuth(), requireHousehold()] as const;

const PostBody = z.object({
  scheduled_for: z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'scheduled_for must be ISO8601' }),
});

// postgres.js parses timestamptz to a JS Date; serialize via
// toISOString() so the wire format is ISO-8601 with the 'T' separator
// and 'Z' suffix iOS's ISO8601DateFormatter requires. (Postgres's own
// ::text rendering uses a space separator + '+00' offset, which that
// parser silently rejects.)
interface StateRow {
  last_watering_notification_at: Date | null;
}

function isoOrNull(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

export const wateringStateRoutes = new Hono<AppEnv>();

// GET /api/households/:id/watering-state — read the household's current
// last-watering-notification timestamp (ISO8601 string or null).
//
// `:id` must match the session's resolved household; mismatches return 404
// to avoid leaking household existence across tenants.
wateringStateRoutes.get('/households/:id/watering-state', ...auth, async (c) => {
  const sql = getSql(c.env);
  const sessionHouseholdId = c.get('householdId') as string;
  const paramId = c.req.param('id');
  if (paramId !== sessionHouseholdId) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'household not found' } }, 404);
  }

  const row = await dbGet<StateRow>(
    sql,
    `SELECT last_watering_notification_at
       FROM households
      WHERE id = $1`,
    [sessionHouseholdId],
  );
  if (!row) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'household not found' } }, 404);
  }

  return c.json({
    ok: true,
    data: { last_watering_notification_at: isoOrNull(row.last_watering_notification_at) },
  });
});

// POST /api/households/:id/watering-state — record that a watering
// notification was scheduled. The server keeps the MAX of the existing
// timestamp and the body's `scheduled_for`, so older replays (e.g. a slow
// secondary device finishing after the primary) never regress state.
//
// Idempotent: two devices POSTing within seconds both succeed; PostgreSQL
// serializes the UPDATEs and `GREATEST` ensures monotonic progression.
wateringStateRoutes.post('/households/:id/watering-state', ...auth, async (c) => {
  const sql = getSql(c.env);
  const sessionHouseholdId = c.get('householdId') as string;
  const paramId = c.req.param('id');
  if (paramId !== sessionHouseholdId) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'household not found' } }, 404);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = PostBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        ok: false,
        error: {
          code: 'bad_request',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        },
      },
      400,
    );
  }

  const scheduledForIso = new Date(parsed.data.scheduled_for).toISOString();

  // GREATEST(COALESCE(existing, $2), $2) collapses the two-state matrix
  // (null vs set) into a single expression: when existing is null, COALESCE
  // returns $2 and GREATEST is trivially $2; when existing is set, the
  // larger of (existing, $2) wins.
  const row = await dbGet<StateRow>(
    sql,
    `UPDATE households
        SET last_watering_notification_at =
              GREATEST(COALESCE(last_watering_notification_at, $2::timestamptz), $2::timestamptz)
      WHERE id = $1
      RETURNING last_watering_notification_at`,
    [sessionHouseholdId, scheduledForIso],
  );

  if (!row) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'household not found' } }, 404);
  }

  return c.json({
    ok: true,
    data: { last_watering_notification_at: isoOrNull(row.last_watering_notification_at) },
  });
});
