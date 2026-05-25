// Sprout tool registry. Each tool has:
//   - A zod schema for server-side arg validation (rejects calls before the
//     executor runs).
//   - A description shown to the LLM (this is the "API doc" Anthropic sees).
//   - A `requires_confirmation` flag — true for destructive or
//     structurally-significant ops; the executor emits a `proposed_change`
//     event instead of executing immediately, and the user confirms in the UI.
//
// Read tools (auto): list_*, get_*, search_*, get_household_location.
// Write tools (auto-execute): create_*, add_/toggle_checklist_item.
// Write tools (confirm-required): update_*, delete_*, set_household_location.

import { z } from 'zod';

const YYYY_MM_DD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

// ── Read tools ─────────────────────────────────────────────────────────────

const ListSeedsArgs = z.object({
  state: z.enum(['active', 'wishlist', 'saved', 'archived']).optional(),
  location_id: z.string().optional(),
  search: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();

const GetSeedArgs = z.object({ id: z.string() }).strict();

const ListBedsArgs = z.object({
  active: z.boolean().default(true),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();

const GetBedArgs = z.object({ id: z.string() }).strict();

const ListPlantingEventsArgs = z.object({
  bed_id: z.string().optional(),
  seed_id: z.string().optional(),
  kind: z.enum(['sowing', 'transplant', 'harvest']).optional(),
  from: YYYY_MM_DD.optional(),
  to: YYYY_MM_DD.optional(),
  limit: z.number().int().min(1).max(200).default(100),
}).strict();

const GetPlantingEventArgs = z.object({ id: z.string() }).strict();

const ListJournalEntriesArgs = z.object({
  seed_id: z.string().optional(),
  bed_id: z.string().optional(),
  planting_event_id: z.string().optional(),
  from: YYYY_MM_DD.optional(),
  to: YYYY_MM_DD.optional(),
  search: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(100),
}).strict();

const GetJournalEntryArgs = z.object({ id: z.string() }).strict();

const GetRecommendationArgs = z.object({ catalog_seed_id: z.string() }).strict();

const SearchCatalogArgs = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();

const GetHouseholdLocationArgs = z.object({}).strict();

// ── Write tools (auto-execute) ─────────────────────────────────────────────

const CreatePlantingEventArgs = z.object({
  bed_id: z.string(),
  seed_id: z.string().optional(),
  catalog_seed_id: z.string().optional(),
  kind: z.enum(['sowing', 'transplant', 'harvest']),
  planned_for: YYYY_MM_DD,
  notes: z.string().optional(),
  x_feet: z.number().optional(),
  y_feet: z.number().optional(),
}).strict();

const CreateJournalEntryArgs = z.object({
  occurred_on: YYYY_MM_DD,
  body: z.string(),
  seed_id: z.string().optional(),
  bed_id: z.string().optional(),
  planting_event_id: z.string().optional(),
}).strict().refine(
  (v) => [v.seed_id, v.bed_id, v.planting_event_id].filter((x) => x != null).length <= 1,
  { message: 'attach to at most one of seed_id, bed_id, planting_event_id' },
);

const AddChecklistItemArgs = z.object({
  entry_id: z.string(),
  text: z.string().min(1),
}).strict();

const ToggleChecklistItemArgs = z.object({
  item_id: z.string(),
  completed: z.boolean(),
}).strict();

// ── Write tools (require confirmation) ─────────────────────────────────────

const UpdatePlantingEventArgs = z.object({
  id: z.string(),
  bed_id: z.string().optional(),
  seed_id: z.string().nullable().optional(),
  kind: z.enum(['sowing', 'transplant', 'harvest']).optional(),
  planned_for: YYYY_MM_DD.optional(),
  notes: z.string().nullable().optional(),
}).strict();

const UpdateJournalEntryArgs = z.object({
  id: z.string(),
  body: z.string().optional(),
  occurred_on: YYYY_MM_DD.optional(),
  seed_id: z.string().nullable().optional(),
  bed_id: z.string().nullable().optional(),
  planting_event_id: z.string().nullable().optional(),
}).strict();

const UpdateSeedArgs = z.object({
  id: z.string(),
  custom_name: z.string().nullable().optional(),
  state: z.enum(['active', 'wishlist', 'saved', 'archived']).optional(),
  packet_count: z.number().int().nullable().optional(),
  location_id: z.string().nullable().optional(),
  year_packed: z.number().int().nullable().optional(),
  notes: z.string().nullable().optional(),
}).strict();

const UpdateBedArgs = z.object({
  id: z.string(),
  name: z.string().optional(),
  width_feet: z.number().nullable().optional(),
  length_feet: z.number().nullable().optional(),
}).strict();

const DeletePlantingEventArgs = z.object({ id: z.string() }).strict();
const DeleteJournalEntryArgs = z.object({ id: z.string() }).strict();
const DeleteSeedArgs = z.object({ id: z.string() }).strict();
const DeleteBedArgs = z.object({ id: z.string() }).strict();

const SetHouseholdLocationArgs = z.object({
  zip: z.string().regex(/^\d{5}$/, 'ZIP must be 5 digits'),
}).strict();

// ── Registry ───────────────────────────────────────────────────────────────

export type ToolName =
  // read
  | 'list_seeds' | 'get_seed'
  | 'list_beds' | 'get_bed'
  | 'list_planting_events' | 'get_planting_event'
  | 'list_journal_entries' | 'get_journal_entry'
  | 'get_recommendation' | 'search_catalog'
  | 'get_household_location'
  // write (auto-execute)
  | 'create_planting_event' | 'create_journal_entry'
  | 'add_checklist_item' | 'toggle_checklist_item'
  // write (require proposed-change confirmation)
  | 'update_planting_event' | 'update_journal_entry'
  | 'update_seed' | 'update_bed'
  | 'delete_planting_event' | 'delete_journal_entry'
  | 'delete_seed' | 'delete_bed'
  | 'set_household_location';

export interface ToolDef {
  name: ToolName;
  description: string;
  schema: z.ZodTypeAny;
  requires_confirmation: boolean;
}

export const TOOL_REGISTRY: Record<ToolName, ToolDef> = {
  // ── Read ─────────────────────────────────────────────────────────────────
  list_seeds: {
    name: 'list_seeds',
    description: 'List seeds in the user\'s inventory, optionally filtered by state, location, or text search across name/variety.',
    schema: ListSeedsArgs,
    requires_confirmation: false,
  },
  get_seed: {
    name: 'get_seed',
    description: 'Get full detail for a single seed by id, including catalog growing info if linked.',
    schema: GetSeedArgs,
    requires_confirmation: false,
  },
  list_beds: {
    name: 'list_beds',
    description: 'List garden beds in the household.',
    schema: ListBedsArgs,
    requires_confirmation: false,
  },
  get_bed: {
    name: 'get_bed',
    description: 'Get full detail for a single bed by id, including dimensions and any layout positions.',
    schema: GetBedArgs,
    requires_confirmation: false,
  },
  list_planting_events: {
    name: 'list_planting_events',
    description: 'List planting events (sowing, transplant, harvest), optionally filtered by bed, seed, kind, or date range.',
    schema: ListPlantingEventsArgs,
    requires_confirmation: false,
  },
  get_planting_event: {
    name: 'get_planting_event',
    description: 'Get full detail for a single planting event by id.',
    schema: GetPlantingEventArgs,
    requires_confirmation: false,
  },
  list_journal_entries: {
    name: 'list_journal_entries',
    description: 'List the user\'s journal entries, optionally filtered by entity (seed/bed/event), date range, or text search across the body.',
    schema: ListJournalEntriesArgs,
    requires_confirmation: false,
  },
  get_journal_entry: {
    name: 'get_journal_entry',
    description: 'Get full detail for a single journal entry by id, including photos and checklist items.',
    schema: GetJournalEntryArgs,
    requires_confirmation: false,
  },
  get_recommendation: {
    name: 'get_recommendation',
    description: 'Get the current planting-window recommendation for a catalog seed (when to plant, indoor-start window, verdict).',
    schema: GetRecommendationArgs,
    requires_confirmation: false,
  },
  search_catalog: {
    name: 'search_catalog',
    description: 'Search the shared seed catalog by common name or variety.',
    schema: SearchCatalogArgs,
    requires_confirmation: false,
  },
  get_household_location: {
    name: 'get_household_location',
    description: 'Get the user\'s home ZIP, USDA hardiness zone, average frost dates, and region (state code).',
    schema: GetHouseholdLocationArgs,
    requires_confirmation: false,
  },

  // ── Write (auto-execute) ─────────────────────────────────────────────────
  create_planting_event: {
    name: 'create_planting_event',
    description: 'Create a new planting event (sowing, transplant, or harvest) in a bed. Supply either seed_id (household seed) or catalog_seed_id (generic crop), or neither for a free-form bed event.',
    schema: CreatePlantingEventArgs,
    requires_confirmation: false,
  },
  create_journal_entry: {
    name: 'create_journal_entry',
    description: 'Create a journal entry. Attach to AT MOST ONE of seed_id, bed_id, or planting_event_id. Leave all three null for a garden-level entry.',
    schema: CreateJournalEntryArgs,
    requires_confirmation: false,
  },
  add_checklist_item: {
    name: 'add_checklist_item',
    description: 'Add a checklist item to a journal entry.',
    schema: AddChecklistItemArgs,
    requires_confirmation: false,
  },
  toggle_checklist_item: {
    name: 'toggle_checklist_item',
    description: 'Toggle the completed state of a checklist item.',
    schema: ToggleChecklistItemArgs,
    requires_confirmation: false,
  },

  // ── Write (require confirmation) ─────────────────────────────────────────
  update_planting_event: {
    name: 'update_planting_event',
    description: 'Update fields of a planting event. Only fields you provide will change. Will surface a Was→Becomes diff for the user to confirm before applying.',
    schema: UpdatePlantingEventArgs,
    requires_confirmation: true,
  },
  update_journal_entry: {
    name: 'update_journal_entry',
    description: 'Update fields of a journal entry. Only fields you provide will change. Will surface a Was→Becomes diff for the user to confirm before applying.',
    schema: UpdateJournalEntryArgs,
    requires_confirmation: true,
  },
  update_seed: {
    name: 'update_seed',
    description: 'Update fields of a seed (name, state, packet count, location, etc.). Surfaces a Was→Becomes diff for user confirmation.',
    schema: UpdateSeedArgs,
    requires_confirmation: true,
  },
  update_bed: {
    name: 'update_bed',
    description: 'Update a bed\'s name or dimensions. Surfaces a Was→Becomes diff for user confirmation.',
    schema: UpdateBedArgs,
    requires_confirmation: true,
  },
  delete_planting_event: {
    name: 'delete_planting_event',
    description: 'Soft-delete a planting event. Requires user confirmation.',
    schema: DeletePlantingEventArgs,
    requires_confirmation: true,
  },
  delete_journal_entry: {
    name: 'delete_journal_entry',
    description: 'Soft-delete a journal entry. Requires user confirmation.',
    schema: DeleteJournalEntryArgs,
    requires_confirmation: true,
  },
  delete_seed: {
    name: 'delete_seed',
    description: 'Soft-delete a seed from inventory. Requires user confirmation.',
    schema: DeleteSeedArgs,
    requires_confirmation: true,
  },
  delete_bed: {
    name: 'delete_bed',
    description: 'Soft-delete a bed. Requires user confirmation.',
    schema: DeleteBedArgs,
    requires_confirmation: true,
  },
  set_household_location: {
    name: 'set_household_location',
    description: 'Change the user\'s home ZIP (which drives planting-window recommendations household-wide). Requires user confirmation.',
    schema: SetHouseholdLocationArgs,
    requires_confirmation: true,
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

export function validateToolArgs(
  name: string,
  args: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false; reason: string } {
  const def = TOOL_REGISTRY[name as ToolName];
  if (!def) return { ok: false, reason: `unknown tool: ${name}` };
  const parsed = def.schema.safeParse(args);
  if (!parsed.success) {
    const reason = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { ok: false, reason };
  }
  return { ok: true, args: parsed.data as Record<string, unknown> };
}

/**
 * Anthropic-shape tool definitions for the Messages API `tools` parameter.
 * Generates JSON Schema from each tool's zod schema using zod 4's native
 * `z.toJSONSchema()`.
 */
export function anthropicTools(): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  return Object.values(TOOL_REGISTRY).map((def) => ({
    name: def.name,
    description: def.description,
    input_schema: z.toJSONSchema(def.schema) as Record<string, unknown>,
  }));
}
