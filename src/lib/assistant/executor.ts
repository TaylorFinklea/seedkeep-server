// Sprout tool executor — maps tool calls to direct SQL operations.
//
// For auto-execute tools (reads + low-risk creates), runs the DB op and
// returns the result immediately so it can be fed back to the LLM.
//
// For confirm-required tools (updates, deletes, location change), returns
// status='proposed' with a `was → becomes` diff WITHOUT mutating. The
// streaming endpoint pauses, the user confirms in the UI, then
// `executeProposedChange` is called to actually apply.

import { nanoid } from 'nanoid';
import type { getSql } from '../../db/client';
import { dbGet, dbAll, dbRun } from '../../db/helpers';
import { validateToolArgs, TOOL_REGISTRY, type ToolName } from './tools';

/// Safe JSON.parse for TEXT-stored JSON payloads (pet_personality,
/// goodbye_note). Returns null on any error — these blobs are written by
/// our own server code so corruption is unexpected, but the tool handler
/// should still degrade gracefully.
function safeParseJSON(raw: string | null): any {
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return null; }
}

/// Per-turn hint from iOS for derived state the server can't compute on its
/// own. Phase 5.1.5 adds `clientPetState`: when the iOS assistant turn is
/// likely about pets, it sends each visible planting_event's current iOS-
/// derived mood + age_stars so `query_pet` can return those alongside
/// server-of-record identity. Optional; tools handle missing entries by
/// returning null for those fields.
export interface ClientPetStateEntry {
  mood: 'thriving' | 'content' | 'quiet' | 'wilted' | 'departingImminent';
  age_stars: number;
}

export interface ToolExecutionContext {
  sql: ReturnType<typeof getSql>;
  householdId: string;
  clientPetState?: Record<string, ClientPetStateEntry>;
}

export interface ToolExecutionResult {
  status: 'done' | 'failed' | 'proposed';
  result?: unknown;
  proposed_change?: unknown;
  error?: { code: string; message: string };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Execute a tool call. Validates args, then either runs the DB op (auto)
 * or returns a `{ was, becomes }` diff (confirm-required).
 */
export async function executeTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const validated = validateToolArgs(name, rawArgs);
  if (!validated.ok) {
    return { status: 'failed', error: { code: 'invalid_args', message: validated.reason } };
  }
  const def = TOOL_REGISTRY[name as ToolName];
  const args = validated.args;

  try {
    if (def.requires_confirmation) {
      const diff = await previewDestructive(name as ToolName, args, ctx);
      return { status: 'proposed', proposed_change: diff };
    }
    const result = await runAutoExecute(name as ToolName, args, ctx);
    return { status: 'done', result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'failed', error: { code: 'execution_error', message } };
  }
}

/**
 * Apply a previously-proposed destructive change. Called by the /confirm
 * route once the user has approved the diff.
 *
 * Optional `storedWas` is the `was` snapshot captured at preview time.
 * When provided, we re-read the current row before applying and compare
 * — if the row has changed (another device wrote between preview and
 * confirm), we refuse with `stale_proposal` so the user can re-review
 * the now-stale diff instead of silently applying a different change
 * than what they saw.
 */
export async function executeProposedChange(
  name: string,
  rawArgs: unknown,
  ctx: ToolExecutionContext,
  storedWas?: unknown,
): Promise<ToolExecutionResult> {
  const validated = validateToolArgs(name, rawArgs);
  if (!validated.ok) {
    return { status: 'failed', error: { code: 'invalid_args', message: validated.reason } };
  }
  if (storedWas != null) {
    try {
      const current = await readCurrentWas(name as ToolName, validated.args, ctx);
      if (current !== null && !wasMatches(storedWas, current)) {
        return {
          status: 'failed',
          error: {
            code: 'stale_proposal',
            message: 'The target row changed since this proposal was created. Cancel and ask again so you can review the current state.',
          },
        };
      }
    } catch {
      // If we can't read the current `was` (e.g. row deleted between
      // preview and confirm), fall through — applyDestructive will fail
      // with a more specific error.
    }
  }
  try {
    const result = await applyDestructive(name as ToolName, validated.args, ctx);
    return { status: 'done', result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'failed', error: { code: 'execution_error', message } };
  }
}

/// Re-runs the same SELECT as `previewDestructive` so the caller can
/// compare current state to what the user saw at proposal time.
async function readCurrentWas(
  name: ToolName,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<Record<string, unknown> | null> {
  // For deletes the "was" comparison is whether the row still exists.
  // For updates, we read the columns previewDestructive showed. For
  // set_household_location, the user sees household state — re-read it.
  const { sql, householdId } = ctx;
  switch (name) {
    case 'update_planting_event':
    case 'delete_planting_event':
      return (await dbGet(sql,
        `SELECT id, bed_id, seed_id, catalog_seed_id, kind, planned_for::text AS planned_for,
                completed_at, notes, x_feet, y_feet
           FROM planting_events WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [args.id, householdId])) as Record<string, unknown> | null;
    case 'update_journal_entry':
    case 'delete_journal_entry':
      return (await dbGet(sql,
        `SELECT id, occurred_on::text AS occurred_on, body, seed_id, bed_id, planting_event_id
           FROM journal_entries WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [args.id, householdId])) as Record<string, unknown> | null;
    case 'update_seed':
    case 'delete_seed':
      return (await dbGet(sql,
        `SELECT id, custom_name, custom_variety, custom_company, state, packet_count,
                year_packed, source, notes, location_id
           FROM seeds WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [args.id, householdId])) as Record<string, unknown> | null;
    case 'update_bed':
    case 'delete_bed':
      return (await dbGet(sql,
        `SELECT id, name, width_feet, length_feet, sort_order
           FROM beds WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [args.id, householdId])) as Record<string, unknown> | null;
    case 'set_household_location':
      return (await dbGet(sql,
        `SELECT home_zip, latitude, longitude, usda_zone, avg_last_frost, avg_first_frost, region_id
           FROM households WHERE id = $1 LIMIT 1`,
        [householdId])) as Record<string, unknown> | null;
    default:
      return null;
  }
}

/// Field-by-field shallow comparison. Both inputs come from the same
/// SELECT shape, so we only check the keys present in the stored
/// snapshot. Treats null and undefined as equal so JSON round-tripping
/// doesn't trip us up.
function wasMatches(stored: unknown, current: Record<string, unknown>): boolean {
  if (typeof stored !== 'object' || stored === null) return true;
  const s = stored as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    const a = s[key];
    const b = current[key];
    if (a == null && b == null) continue;
    if (a == null || b == null) return false;
    if (a instanceof Date || b instanceof Date) {
      if (String(a) !== String(b)) return false;
      continue;
    }
    if (typeof a === 'object' || typeof b === 'object') {
      if (JSON.stringify(a) !== JSON.stringify(b)) return false;
      continue;
    }
    if (a !== b) return false;
  }
  return true;
}

// ── Auto-execute handlers (reads + creates + checklist) ────────────────────

async function runAutoExecute(
  name: ToolName,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<unknown> {
  const { sql, householdId } = ctx;

  switch (name) {
    case 'list_seeds': {
      const wheres: string[] = ['household_id = $1', 'deleted_at IS NULL'];
      const params: unknown[] = [householdId];
      let p = 2;
      if (args.state) { wheres.push(`state = $${p++}`); params.push(args.state); }
      if (args.location_id) { wheres.push(`location_id = $${p++}`); params.push(args.location_id); }
      if (args.search) {
        wheres.push(`(custom_name ILIKE $${p} OR custom_variety ILIKE $${p} OR custom_company ILIKE $${p})`);
        params.push(`%${args.search}%`);
        p++;
      }
      params.push(args.limit ?? 50);
      const rows = await dbAll(sql,
        `SELECT id, custom_name, custom_variety, custom_company, state, packet_count,
                year_packed, source, notes, catalog_id, location_id, created_at, updated_at
           FROM seeds WHERE ${wheres.join(' AND ')}
          ORDER BY updated_at DESC LIMIT $${p}`,
        params);
      return { seeds: rows };
    }

    case 'get_seed': {
      const row = await dbGet(sql,
        `SELECT s.*,
                cs.common_name AS catalog_common_name, cs.variety AS catalog_variety,
                cs.frost_tolerance, cs.soil_temp_min_f, cs.soil_temp_max_f,
                cs.days_to_germination, cs.days_to_maturity, cs.sow_method
           FROM seeds s
           LEFT JOIN catalog_seeds cs ON cs.id = s.catalog_id
          WHERE s.id = $1 AND s.household_id = $2 AND s.deleted_at IS NULL LIMIT 1`,
        [args.id, householdId]);
      if (!row) throw new Error(`seed not found: ${args.id}`);
      return { seed: row };
    }

    case 'list_beds': {
      const wheres: string[] = ['household_id = $1'];
      const params: unknown[] = [householdId];
      let p = 2;
      if (args.active !== false) { wheres.push('deleted_at IS NULL'); }
      params.push(args.limit ?? 50);
      const rows = await dbAll(sql,
        `SELECT id, name, width_feet, length_feet, sort_order, created_at, updated_at, deleted_at
           FROM beds WHERE ${wheres.join(' AND ')}
          ORDER BY sort_order ASC LIMIT $${p}`,
        params);
      return { beds: rows };
    }

    case 'get_bed': {
      const row = await dbGet(sql,
        `SELECT id, name, width_feet, length_feet, sort_order, created_at, updated_at
           FROM beds WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [args.id, householdId]);
      if (!row) throw new Error(`bed not found: ${args.id}`);
      return { bed: row };
    }

    case 'list_planting_events': {
      const wheres: string[] = ['household_id = $1', 'deleted_at IS NULL'];
      const params: unknown[] = [householdId];
      let p = 2;
      if (args.bed_id) { wheres.push(`bed_id = $${p++}`); params.push(args.bed_id); }
      if (args.seed_id) { wheres.push(`seed_id = $${p++}`); params.push(args.seed_id); }
      if (args.kind) { wheres.push(`kind = $${p++}`); params.push(args.kind); }
      if (args.from) { wheres.push(`planned_for >= $${p++}`); params.push(args.from); }
      if (args.to) { wheres.push(`planned_for <= $${p++}`); params.push(args.to); }
      params.push(args.limit ?? 100);
      const rows = await dbAll(sql,
        `SELECT id, bed_id, seed_id, catalog_seed_id, kind, planned_for::text AS planned_for,
                completed_at, notes, x_feet, y_feet, created_at, updated_at
           FROM planting_events WHERE ${wheres.join(' AND ')}
          ORDER BY planned_for DESC, id DESC LIMIT $${p}`,
        params);
      return { events: rows };
    }

    case 'get_planting_event': {
      const row = await dbGet(sql,
        `SELECT id, bed_id, seed_id, catalog_seed_id, kind, planned_for::text AS planned_for,
                completed_at, notes, x_feet, y_feet, created_at, updated_at
           FROM planting_events WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [args.id, householdId]);
      if (!row) throw new Error(`planting event not found: ${args.id}`);
      return { event: row };
    }

    case 'list_journal_entries': {
      const wheres: string[] = ['household_id = $1', 'deleted_at IS NULL'];
      const params: unknown[] = [householdId];
      let p = 2;
      if (args.seed_id) { wheres.push(`seed_id = $${p++}`); params.push(args.seed_id); }
      if (args.bed_id) { wheres.push(`bed_id = $${p++}`); params.push(args.bed_id); }
      if (args.planting_event_id) { wheres.push(`planting_event_id = $${p++}`); params.push(args.planting_event_id); }
      if (args.from) { wheres.push(`occurred_on >= $${p++}`); params.push(args.from); }
      if (args.to) { wheres.push(`occurred_on <= $${p++}`); params.push(args.to); }
      if (args.search) { wheres.push(`body ILIKE $${p}`); params.push(`%${args.search}%`); p++; }
      params.push(args.limit ?? 100);
      const rows = await dbAll(sql,
        `SELECT id, occurred_on::text AS occurred_on, body, seed_id, bed_id, planting_event_id,
                created_at, updated_at
           FROM journal_entries WHERE ${wheres.join(' AND ')}
          ORDER BY occurred_on DESC, id DESC LIMIT $${p}`,
        params);
      return { entries: rows };
    }

    case 'get_journal_entry': {
      const entry = await dbGet(sql,
        `SELECT id, occurred_on::text AS occurred_on, body, seed_id, bed_id, planting_event_id,
                created_at, updated_at
           FROM journal_entries
          WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [args.id, householdId]);
      if (!entry) throw new Error(`journal entry not found: ${args.id}`);
      const photos = await dbAll(sql,
        `SELECT id, storage_key, sort_order, width, height, created_at
           FROM journal_entry_photos WHERE entry_id = $1 ORDER BY sort_order ASC`,
        [args.id]);
      const items = await dbAll(sql,
        `SELECT id, text, completed, sort_order, updated_at
           FROM journal_checklist_items WHERE entry_id = $1 ORDER BY sort_order ASC`,
        [args.id]);
      return { entry, photos, checklist_items: items };
    }

    case 'get_recommendation': {
      // Read the most recent cache row for this catalog_seed_id matching
      // the household's location_signature. Don't trigger a fresh compute
      // from the assistant — that's the regular recommendation route's job.
      const row = await dbGet(sql,
        `SELECT rc.*
           FROM recommendation_cache rc
           JOIN households h ON h.id = $2
          WHERE rc.catalog_seed_id = $1 LIMIT 1`,
        [args.catalog_seed_id, householdId]);
      if (!row) {
        return { recommendation: null, note: 'No cached recommendation yet — the user may need to open this seed in the app to trigger one.' };
      }
      return { recommendation: row };
    }

    case 'search_catalog': {
      const rows = await dbAll(sql,
        `SELECT id, common_name, variety, sow_method, frost_tolerance,
                days_to_germination, days_to_maturity
           FROM catalog_seeds
          WHERE (common_name ILIKE $1 OR variety ILIKE $1) AND status = 'published'
          ORDER BY common_name ASC LIMIT $2`,
        [`%${args.query}%`, args.limit ?? 20]);
      return { catalog_seeds: rows };
    }

    case 'get_household_location': {
      const row = await dbGet(sql,
        `SELECT home_zip, latitude, longitude, usda_zone, avg_last_frost, avg_first_frost, region_id
           FROM households WHERE id = $1 LIMIT 1`,
        [householdId]);
      return { location: row ?? null };
    }

    case 'query_pet': {
      // First multi-table tool handler — joins planting_events to
      // pet_departures so we can compute `status` server-side. Aliases
      // are required here (deviation from the single-table bare-column
      // convention; flagged in the Sprout-integration spec section).
      const conditions: string[] = ['pe.household_id = $1', 'pe.deleted_at IS NULL', 'pe.pet_seed IS NOT NULL'];
      const params: unknown[] = [householdId];
      if (args.planting_event_id) {
        params.push(args.planting_event_id);
        conditions.push(`pe.id = $${params.length}`);
      }
      if (args.seed_id) {
        params.push(args.seed_id);
        conditions.push(`pe.seed_id = $${params.length}`);
      }
      if (args.bed_id) {
        params.push(args.bed_id);
        conditions.push(`pe.bed_id = $${params.length}`);
      }
      if (args.rarity) {
        params.push(args.rarity);
        conditions.push(`pe.pet_rarity = $${params.length}`);
      }
      // Status filter using server-derivable lifecycle outcomes.
      if (args.status === 'alive') {
        conditions.push(`pe.completed_at IS NULL`);
        conditions.push(`pd.planting_event_id IS NULL`);
      } else if (args.status === 'departed') {
        conditions.push(`pd.planting_event_id IS NOT NULL`);
      } else if (args.status === 'graduated') {
        conditions.push(`pe.completed_at IS NOT NULL`);
        conditions.push(`pd.planting_event_id IS NULL`);
      }
      params.push(args.limit);
      const rows = await dbAll<{
        id: string;
        pet_name: string | null;
        pet_rarity: string | null;
        pet_creature_kind: string | null;
        pet_personality: string | null;
        pet_spawned_at: string | null;
        completed_at: string | null;
        departed_at: string | null;
        goodbye_note: string | null;
      }>(sql,
        `SELECT pe.id,
                pe.pet_name, pe.pet_rarity, pe.pet_creature_kind, pe.pet_personality, pe.pet_spawned_at,
                pe.completed_at,
                pd.departed_at, pd.goodbye_note
           FROM planting_events pe
           LEFT JOIN pet_departures pd
                  ON pd.planting_event_id = pe.id AND pd.deleted_at IS NULL
          WHERE ${conditions.join(' AND ')}
          ORDER BY pe.pet_spawned_at DESC NULLS LAST
          LIMIT $${params.length}`,
        params);

      const pets = rows.map((row) => {
        const personality = row.pet_personality
          ? safeParseJSON(row.pet_personality) : null;
        const goodbyeRaw = row.goodbye_note ? safeParseJSON(row.goodbye_note) : null;
        const status: 'alive' | 'departed' | 'graduated' =
          row.departed_at != null ? 'departed'
            : row.completed_at != null ? 'graduated'
            : 'alive';
        const clientEntry = ctx.clientPetState?.[row.id];
        return {
          planting_event_id: row.id,
          name: row.pet_name ?? personality?.name ?? null,
          rarity: row.pet_rarity,
          creature_kind: row.pet_creature_kind,
          vignette: personality?.vignette ?? null,
          age_stars: clientEntry?.age_stars ?? null,
          mood: clientEntry?.mood ?? null,
          status,
          spawned_at: row.pet_spawned_at ? Number(row.pet_spawned_at) : null,
          departed_at: row.departed_at ? Number(row.departed_at) : null,
          completed_at: row.completed_at ? Number(row.completed_at) : null,
          goodbye_note: goodbyeRaw
            ? { note_text: goodbyeRaw.note_text, signoff: goodbyeRaw.signoff }
            : null,
        };
      });

      return { pets };
    }

    case 'create_planting_event': {
      const id = nanoid();
      const now = Date.now();
      await dbRun(sql,
        `INSERT INTO planting_events
           (id, household_id, bed_id, seed_id, catalog_seed_id, kind, planned_for,
            completed_at, notes, x_feet, y_feet, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10, $11, $11)`,
        [id, householdId, args.bed_id ?? null,
          args.seed_id ?? null, args.catalog_seed_id ?? null,
          args.kind, args.planned_for, args.notes ?? null,
          args.x_feet ?? null, args.y_feet ?? null, now]);
      const row = await dbGet(sql,
        `SELECT id, bed_id, seed_id, catalog_seed_id, kind, planned_for::text AS planned_for,
                notes, x_feet, y_feet, created_at, updated_at
           FROM planting_events WHERE id = $1`, [id]);
      return { event: row, created_id: id };
    }

    case 'create_journal_entry': {
      const id = nanoid();
      const now = Date.now();
      await dbRun(sql,
        `INSERT INTO journal_entries
           (id, household_id, occurred_on, body, seed_id, bed_id, planting_event_id,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [id, householdId, args.occurred_on, args.body,
          args.seed_id ?? null, args.bed_id ?? null, args.planting_event_id ?? null, now]);
      const row = await dbGet(sql,
        `SELECT id, occurred_on::text AS occurred_on, body, seed_id, bed_id, planting_event_id,
                created_at, updated_at
           FROM journal_entries WHERE id = $1`, [id]);
      return { entry: row, created_id: id };
    }

    case 'add_checklist_item': {
      // Verify entry belongs to household
      const owner = await dbGet(sql,
        `SELECT id FROM journal_entries
          WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [args.entry_id, householdId]);
      if (!owner) throw new Error(`journal entry not found: ${args.entry_id}`);
      const id = nanoid();
      const now = Date.now();
      const max = await dbGet<{ max: number | null }>(sql,
        `SELECT MAX(sort_order) AS max FROM journal_checklist_items WHERE entry_id = $1`,
        [args.entry_id]);
      const sortOrder = (max?.max ?? -1) + 1;
      await dbRun(sql,
        `INSERT INTO journal_checklist_items
           (id, entry_id, text, completed, sort_order, updated_at)
         VALUES ($1, $2, $3, FALSE, $4, $5)`,
        [id, args.entry_id, args.text, sortOrder, now]);
      await dbRun(sql,
        `UPDATE journal_entries SET updated_at = $1 WHERE id = $2`, [now, args.entry_id]);
      const row = await dbGet(sql,
        `SELECT id, text, completed, sort_order, updated_at
           FROM journal_checklist_items WHERE id = $1`, [id]);
      return { item: row, created_id: id };
    }

    case 'toggle_checklist_item': {
      // Verify ownership via the parent entry
      const owner = await dbGet(sql,
        `SELECT ci.entry_id FROM journal_checklist_items ci
           JOIN journal_entries je ON je.id = ci.entry_id
          WHERE ci.id = $1 AND je.household_id = $2 AND je.deleted_at IS NULL LIMIT 1`,
        [args.item_id, householdId]);
      if (!owner) throw new Error(`checklist item not found: ${args.item_id}`);
      const now = Date.now();
      await dbRun(sql,
        `UPDATE journal_checklist_items SET completed = $1, updated_at = $2 WHERE id = $3`,
        [args.completed, now, args.item_id]);
      await dbRun(sql,
        `UPDATE journal_entries SET updated_at = $1 WHERE id = $2`,
        [now, (owner as { entry_id: string }).entry_id]);
      return { item_id: args.item_id, completed: args.completed };
    }

    default:
      throw new Error(`auto-execute handler missing for tool: ${name}`);
  }
}

// ── Confirm-required: preview (returns diff, no mutation) ──────────────────

interface ProposedChange {
  tool: ToolName;
  description: string;
  was: unknown;
  becomes: unknown;
}

async function previewDestructive(
  name: ToolName,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ProposedChange> {
  const { sql, householdId } = ctx;

  switch (name) {
    case 'update_planting_event': {
      const was = await dbGet(sql,
        `SELECT id, bed_id, seed_id, catalog_seed_id, kind, planned_for::text AS planned_for,
                completed_at, notes, x_feet, y_feet
           FROM planting_events
          WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [args.id, householdId]);
      if (!was) throw new Error(`planting event not found: ${args.id}`);
      return { tool: name, description: `Update planting event ${args.id}`, was, becomes: applyPatch(was as Record<string, unknown>, args) };
    }
    case 'update_journal_entry': {
      const was = await dbGet(sql,
        `SELECT id, occurred_on::text AS occurred_on, body, seed_id, bed_id, planting_event_id
           FROM journal_entries
          WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [args.id, householdId]);
      if (!was) throw new Error(`journal entry not found: ${args.id}`);
      return { tool: name, description: `Update journal entry ${args.id}`, was, becomes: applyPatch(was as Record<string, unknown>, args) };
    }
    case 'update_seed': {
      const was = await dbGet(sql,
        `SELECT id, custom_name, custom_variety, custom_company, state, packet_count,
                year_packed, source, notes, location_id
           FROM seeds WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [args.id, householdId]);
      if (!was) throw new Error(`seed not found: ${args.id}`);
      return { tool: name, description: `Update seed ${args.id}`, was, becomes: applyPatch(was as Record<string, unknown>, args) };
    }
    case 'update_bed': {
      const was = await dbGet(sql,
        `SELECT id, name, width_feet, length_feet, sort_order
           FROM beds WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [args.id, householdId]);
      if (!was) throw new Error(`bed not found: ${args.id}`);
      return { tool: name, description: `Update bed ${args.id}`, was, becomes: applyPatch(was as Record<string, unknown>, args) };
    }
    case 'delete_planting_event':
    case 'delete_journal_entry':
    case 'delete_seed':
    case 'delete_bed': {
      const table = name === 'delete_planting_event' ? 'planting_events'
                  : name === 'delete_journal_entry' ? 'journal_entries'
                  : name === 'delete_seed' ? 'seeds'
                  : 'beds';
      const was = await dbGet(sql,
        `SELECT * FROM ${table} WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [args.id, householdId]);
      if (!was) throw new Error(`${table} row not found: ${args.id}`);
      return { tool: name, description: `Delete ${table} ${args.id}`, was, becomes: null };
    }
    case 'set_household_location': {
      const was = await dbGet(sql,
        `SELECT home_zip, latitude, longitude, usda_zone, avg_last_frost, avg_first_frost, region_id
           FROM households WHERE id = $1 LIMIT 1`,
        [householdId]);
      // We can't precompute the "becomes" without looking up zip_locations,
      // so do that here so the user sees real numbers in the confirmation card.
      const newLoc = await dbGet(sql,
        `SELECT zip AS home_zip, latitude, longitude, usda_zone, avg_last_frost, avg_first_frost
           FROM zip_locations WHERE zip = $1 LIMIT 1`,
        [args.zip]);
      if (!newLoc) throw new Error(`ZIP not in dataset: ${args.zip}`);
      return {
        tool: name,
        description: `Change home location to ZIP ${args.zip}`,
        was,
        becomes: newLoc,
      };
    }
    default:
      throw new Error(`preview handler missing for tool: ${name}`);
  }
}

// ── Confirm-required: apply (actual mutation after user confirmation) ──────

async function applyDestructive(
  name: ToolName,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<unknown> {
  const { sql, householdId } = ctx;
  const now = Date.now();

  switch (name) {
    case 'update_planting_event': {
      const sets: string[] = ['updated_at = $1'];
      const params: unknown[] = [now];
      let p = 2;
      for (const key of [
        'bed_id', 'seed_id', 'catalog_seed_id', 'kind', 'planned_for',
        'completed_at', 'notes', 'x_feet', 'y_feet',
      ]) {
        if (key in args) { sets.push(`${key} = $${p++}`); params.push(args[key]); }
      }
      params.push(args.id, householdId);
      await dbRun(sql,
        `UPDATE planting_events SET ${sets.join(', ')}
           WHERE id = $${p++} AND household_id = $${p} AND deleted_at IS NULL`,
        params);
      return { updated_id: args.id };
    }
    case 'update_journal_entry': {
      const sets: string[] = ['updated_at = $1'];
      const params: unknown[] = [now];
      let p = 2;
      for (const key of ['body', 'occurred_on', 'seed_id', 'bed_id', 'planting_event_id']) {
        if (key in args) { sets.push(`${key} = $${p++}`); params.push(args[key]); }
      }
      params.push(args.id, householdId);
      await dbRun(sql,
        `UPDATE journal_entries SET ${sets.join(', ')}
           WHERE id = $${p++} AND household_id = $${p} AND deleted_at IS NULL`,
        params);
      return { updated_id: args.id };
    }
    case 'update_seed': {
      const sets: string[] = ['updated_at = $1'];
      const params: unknown[] = [now];
      let p = 2;
      for (const key of [
        'custom_name', 'custom_variety', 'custom_company',
        'state', 'packet_count', 'location_id', 'year_packed',
        'source', 'notes',
      ]) {
        if (key in args) { sets.push(`${key} = $${p++}`); params.push(args[key]); }
      }
      params.push(args.id, householdId);
      await dbRun(sql,
        `UPDATE seeds SET ${sets.join(', ')}
           WHERE id = $${p++} AND household_id = $${p} AND deleted_at IS NULL`,
        params);
      return { updated_id: args.id };
    }
    case 'update_bed': {
      const sets: string[] = ['updated_at = $1'];
      const params: unknown[] = [now];
      let p = 2;
      for (const key of ['name', 'width_feet', 'length_feet', 'sort_order']) {
        if (key in args) { sets.push(`${key} = $${p++}`); params.push(args[key]); }
      }
      params.push(args.id, householdId);
      await dbRun(sql,
        `UPDATE beds SET ${sets.join(', ')}
           WHERE id = $${p++} AND household_id = $${p} AND deleted_at IS NULL`,
        params);
      return { updated_id: args.id };
    }
    case 'delete_planting_event': {
      await dbRun(sql,
        `UPDATE planting_events SET deleted_at = $1, updated_at = $1
           WHERE id = $2 AND household_id = $3 AND deleted_at IS NULL`,
        [now, args.id, householdId]);
      return { deleted_id: args.id };
    }
    case 'delete_journal_entry': {
      await dbRun(sql,
        `UPDATE journal_entries SET deleted_at = $1, updated_at = $1
           WHERE id = $2 AND household_id = $3 AND deleted_at IS NULL`,
        [now, args.id, householdId]);
      return { deleted_id: args.id };
    }
    case 'delete_seed': {
      // Cascade: child planting_events + journal_entries referencing
      // this seed lose their parent. Soft-delete them too so iOS sees
      // matching deletes on the next sync — otherwise child rows leak,
      // pointing at a gone seed.
      await dbRun(sql,
        `UPDATE seeds SET deleted_at = $1, updated_at = $1
           WHERE id = $2 AND household_id = $3 AND deleted_at IS NULL`,
        [now, args.id, householdId]);
      await dbRun(sql,
        `UPDATE planting_events SET deleted_at = $1, updated_at = $1
           WHERE seed_id = $2 AND household_id = $3 AND deleted_at IS NULL`,
        [now, args.id, householdId]);
      await dbRun(sql,
        `UPDATE journal_entries SET deleted_at = $1, updated_at = $1
           WHERE seed_id = $2 AND household_id = $3 AND deleted_at IS NULL`,
        [now, args.id, householdId]);
      return { deleted_id: args.id };
    }
    case 'delete_bed': {
      // Cascade: child planting_events + journal_entries scoped to
      // this bed go with the bed.
      await dbRun(sql,
        `UPDATE beds SET deleted_at = $1, updated_at = $1
           WHERE id = $2 AND household_id = $3 AND deleted_at IS NULL`,
        [now, args.id, householdId]);
      await dbRun(sql,
        `UPDATE planting_events SET deleted_at = $1, updated_at = $1
           WHERE bed_id = $2 AND household_id = $3 AND deleted_at IS NULL`,
        [now, args.id, householdId]);
      await dbRun(sql,
        `UPDATE journal_entries SET deleted_at = $1, updated_at = $1
           WHERE bed_id = $2 AND household_id = $3 AND deleted_at IS NULL`,
        [now, args.id, householdId]);
      return { deleted_id: args.id };
    }
    case 'set_household_location': {
      const loc = await dbGet(sql,
        `SELECT zip, latitude, longitude, usda_zone, avg_last_frost, avg_first_frost
           FROM zip_locations WHERE zip = $1 LIMIT 1`,
        [args.zip]);
      if (!loc) throw new Error(`ZIP not in dataset: ${args.zip}`);
      const { zipToRegion } = await import('../recommendation/region');
      const regionId = zipToRegion((loc as { zip: string }).zip);
      await dbRun(sql,
        `UPDATE households
            SET home_zip = $1, latitude = $2, longitude = $3, usda_zone = $4,
                avg_last_frost = $5, avg_first_frost = $6, region_id = $7, updated_at = $8
          WHERE id = $9`,
        [(loc as Record<string, unknown>).zip, (loc as Record<string, unknown>).latitude,
         (loc as Record<string, unknown>).longitude, (loc as Record<string, unknown>).usda_zone,
         (loc as Record<string, unknown>).avg_last_frost, (loc as Record<string, unknown>).avg_first_frost,
         regionId, now, householdId]);
      return { zip: args.zip };
    }
    default:
      throw new Error(`apply handler missing for tool: ${name}`);
  }
}

// ── Pure helper: overlay patch args on a current row to compute `becomes`. ──

export function applyPatch<T extends Record<string, unknown>>(
  was: T,
  patch: Record<string, unknown>,
): T {
  const result: Record<string, unknown> = { ...was };
  for (const key of Object.keys(patch)) {
    if (key === 'id') continue;       // never overlay the id
    result[key] = patch[key];
  }
  return result as T;
}
