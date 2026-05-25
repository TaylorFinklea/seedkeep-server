import { describe, it, expect } from 'vitest';
import { applyPatch, executeTool } from '../executor';

// Most executor tests are deferred to the assistant-smoke.ts integration
// check (Task 10) — they require a real DB. The pure helper `applyPatch` IS
// tested here, plus the public-API error paths that don't touch the DB.

describe('applyPatch', () => {
  it('returns the input row when patch is empty', () => {
    const was = { id: 'x', name: 'A', count: 3 };
    expect(applyPatch(was, {})).toEqual(was);
  });

  it('overlays patch fields onto the original', () => {
    const was = { id: 'x', name: 'A', count: 3 };
    expect(applyPatch(was, { name: 'B' })).toEqual({ id: 'x', name: 'B', count: 3 });
  });

  it('skips the id field even if patch tries to change it', () => {
    const was = { id: 'x', name: 'A' };
    expect(applyPatch(was, { id: 'spoofed', name: 'B' })).toEqual({ id: 'x', name: 'B' });
  });

  it('allows setting fields to null', () => {
    const was = { id: 'x', notes: 'something' };
    expect(applyPatch(was, { notes: null })).toEqual({ id: 'x', notes: null });
  });
});

describe('executeTool — argument validation (no DB)', () => {
  const ctx = { sql: null as never, householdId: 'hh-1' };

  it('returns failed for unknown tool', async () => {
    const r = await executeTool('nonexistent_tool', {}, ctx);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.error?.code).toBe('invalid_args');
  });

  it('returns failed for invalid args before touching the DB', async () => {
    // create_planting_event requires bed_id + kind + planned_for; provide none
    const r = await executeTool('create_planting_event', {}, ctx);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.error?.code).toBe('invalid_args');
  });

  it('rejects extra unknown fields in strict-mode tools', async () => {
    const r = await executeTool('list_seeds', { unknown: 'x' }, ctx);
    expect(r.status).toBe('failed');
  });

  it('rejects journal entry with multiple parent FKs', async () => {
    const r = await executeTool('create_journal_entry', {
      occurred_on: '2026-05-25', body: 'test',
      seed_id: 's1', bed_id: 'b1',
    }, ctx);
    expect(r.status).toBe('failed');
  });
});
