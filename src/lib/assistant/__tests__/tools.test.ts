import { describe, it, expect } from 'vitest';
import { TOOL_REGISTRY, validateToolArgs, anthropicTools, type ToolName } from '../tools';

describe('TOOL_REGISTRY', () => {
  it('has all expected tools (25 total)', () => {
    const names = Object.keys(TOOL_REGISTRY).sort();
    expect(names.length).toBe(25);
  });

  it('every tool has a name, description, schema, and confirmation flag', () => {
    for (const [name, def] of Object.entries(TOOL_REGISTRY)) {
      expect(def.name).toBe(name);
      expect(def.description.length).toBeGreaterThan(10);
      expect(def.schema).toBeDefined();
      expect(typeof def.requires_confirmation).toBe('boolean');
    }
  });

  it('marks destructive tools as requiring confirmation', () => {
    const confirmRequired: ToolName[] = [
      'update_planting_event', 'update_journal_entry', 'update_seed', 'update_bed',
      'delete_planting_event', 'delete_journal_entry', 'delete_seed', 'delete_bed',
      'set_household_location',
    ];
    for (const name of confirmRequired) {
      expect(TOOL_REGISTRY[name].requires_confirmation, name).toBe(true);
    }
  });

  it('marks reads + creates as auto-execute', () => {
    const autoExecute: ToolName[] = [
      'list_seeds', 'get_seed', 'list_beds', 'get_bed',
      'list_planting_events', 'get_planting_event',
      'list_journal_entries', 'get_journal_entry',
      'get_recommendation', 'search_catalog', 'get_household_location',
      'create_planting_event', 'create_journal_entry',
      'add_checklist_item', 'toggle_checklist_item',
    ];
    for (const name of autoExecute) {
      expect(TOOL_REGISTRY[name].requires_confirmation, name).toBe(false);
    }
  });

  it('has 12 read auto, 4 write auto, 9 confirm-required', () => {
    const counts = { read: 0, writeAuto: 0, confirm: 0 };
    for (const def of Object.values(TOOL_REGISTRY)) {
      if (def.requires_confirmation) counts.confirm++;
      else if (def.name.startsWith('create_') || def.name.includes('_checklist_item')) counts.writeAuto++;
      else counts.read++;
    }
    expect(counts).toEqual({ read: 12, writeAuto: 4, confirm: 9 });
  });
});

describe('validateToolArgs', () => {
  it('accepts valid create_planting_event args', () => {
    const r = validateToolArgs('create_planting_event', {
      bed_id: 'b1', kind: 'sowing', planned_for: '2026-06-01',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.kind).toBe('sowing');
  });

  it('rejects missing required field', () => {
    const r = validateToolArgs('create_planting_event', { bed_id: 'b1' });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown field (strict mode)', () => {
    const r = validateToolArgs('list_seeds', { unknown_field: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('unknown');
  });

  it('rejects bad enum value', () => {
    const r = validateToolArgs('create_planting_event', {
      bed_id: 'b1', kind: 'invalid', planned_for: '2026-06-01',
    });
    expect(r.ok).toBe(false);
  });

  it('rejects bad YYYY-MM-DD format', () => {
    const r = validateToolArgs('create_planting_event', {
      bed_id: 'b1', kind: 'sowing', planned_for: '2026/06/01',
    });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown tool name', () => {
    const r = validateToolArgs('does_not_exist', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('unknown tool');
  });

  it('rejects journal entry with multiple parent attachments', () => {
    const r = validateToolArgs('create_journal_entry', {
      occurred_on: '2026-05-25', body: 'test',
      seed_id: 's1', bed_id: 'b1',
    });
    expect(r.ok).toBe(false);
  });

  it('accepts journal entry with zero parent attachments (garden-level)', () => {
    const r = validateToolArgs('create_journal_entry', {
      occurred_on: '2026-05-25', body: 'garden note',
    });
    expect(r.ok).toBe(true);
  });

  it('applies defaults (limit = 50 for list_seeds)', () => {
    const r = validateToolArgs('list_seeds', {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.limit).toBe(50);
  });

  it('rejects ZIP that is not 5 digits', () => {
    const r = validateToolArgs('set_household_location', { zip: '1234' });
    expect(r.ok).toBe(false);
  });
});

describe('anthropicTools', () => {
  it('returns one entry per tool, shaped for the Anthropic API', () => {
    const tools = anthropicTools();
    expect(tools.length).toBe(Object.keys(TOOL_REGISTRY).length);
    for (const t of tools) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(t.input_schema).toBeDefined();
      expect((t.input_schema as Record<string, unknown>).type).toBe('object');
    }
  });

  it('JSON schemas include declared fields', () => {
    const tools = anthropicTools();
    const createEvent = tools.find((t) => t.name === 'create_planting_event')!;
    const props = (createEvent.input_schema as { properties: Record<string, unknown> }).properties;
    expect(props.bed_id).toBeDefined();
    expect(props.kind).toBeDefined();
    expect(props.planned_for).toBeDefined();
  });
});
