import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, type HouseholdSnapshot } from '../prompt';

const FULL_SNAPSHOT: HouseholdSnapshot = {
  homeZip: '66109',
  usdaZone: '6b',
  avgLastFrost: '04-22',
  avgFirstFrost: '10-18',
  regionId: 'KS',
  seedCount: 12,
  bedCount: 3,
  recentJournalEntryCount: 4,
};

const NOW = new Date('2026-05-25T14:30:00Z');

describe('buildSystemPrompt', () => {
  it('includes the persona section', () => {
    const p = buildSystemPrompt(FULL_SNAPSHOT, null, NOW);
    expect(p).toContain('Sprout');
    expect(p).toContain('plain-spoken');
    expect(p).toContain('Tool use');
  });

  it('includes the current date in YYYY-MM-DD', () => {
    const p = buildSystemPrompt(FULL_SNAPSHOT, null, NOW);
    expect(p).toContain("Today's date: 2026-05-25");
  });

  it('includes the household location snapshot when populated', () => {
    const p = buildSystemPrompt(FULL_SNAPSHOT, null, NOW);
    expect(p).toContain('Home ZIP: 66109');
    expect(p).toContain('USDA zone: 6b');
    expect(p).toContain('Region (state): KS');
    expect(p).toContain('Avg last spring frost: 04-22');
    expect(p).toContain('Avg first fall frost: 10-18');
  });

  it('omits inventory/journal counts so the LLM must call tools', () => {
    // Stale counts in the prompt caused Sprout to confidently say "0 seeds"
    // without ever invoking list_seeds. The snapshot deliberately no longer
    // surfaces these — the persona section instructs tool use instead.
    const p = buildSystemPrompt(FULL_SNAPSHOT, null, NOW);
    expect(p).not.toContain('Inventory:');
    expect(p).not.toContain('Recent activity:');
    expect(p).not.toMatch(/\d+ seeds?\b/);
    expect(p).not.toMatch(/\d+ beds?\b/);
    expect(p).toContain('ALWAYS call the relevant list/get tools first');
  });

  it('handles a missing location gracefully', () => {
    const snapshot: HouseholdSnapshot = {
      homeZip: null, usdaZone: null,
      avgLastFrost: null, avgFirstFrost: null, regionId: null,
      seedCount: 0, bedCount: 0, recentJournalEntryCount: 0,
    };
    const p = buildSystemPrompt(snapshot, null, NOW);
    expect(p).toContain('Home ZIP: (not set)');
    expect(p).toContain('USDA zone: (unknown)');
    // Region/frost lines should be absent when null
    expect(p).not.toContain('Region (state):');
    expect(p).not.toContain('Avg last spring frost:');
  });

  it('includes page context when provided', () => {
    const p = buildSystemPrompt(FULL_SNAPSHOT, {
      pageType: 'seed', entityId: 'seed-123', label: 'Habanada Pepper',
    }, NOW);
    expect(p).toContain('The user is currently viewing: seed — Habanada Pepper');
    expect(p).toContain('id: seed-123');
  });

  it('omits page context line when null', () => {
    const p = buildSystemPrompt(FULL_SNAPSHOT, null, NOW);
    expect(p).not.toContain('The user is currently viewing');
  });

  it('is deterministic for fixed inputs', () => {
    const a = buildSystemPrompt(FULL_SNAPSHOT, null, NOW);
    const b = buildSystemPrompt(FULL_SNAPSHOT, null, NOW);
    expect(a).toBe(b);
  });

  it('formats the date in UTC (not local)', () => {
    // Test a date near the UTC day boundary
    const p = buildSystemPrompt(FULL_SNAPSHOT, null, new Date('2026-12-31T23:59:00Z'));
    expect(p).toContain('2026-12-31');
  });
});
