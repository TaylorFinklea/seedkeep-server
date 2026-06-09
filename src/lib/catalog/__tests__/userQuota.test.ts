/**
 * Phase 4D · userQuota unit tests (pure).
 *
 * Boundary sweep — promotion to power tier, demotion on one revert,
 * daily ceiling math. The DB-backed fetchUserQuotaStats is exercised
 * by tests/integration/correctionWorker.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { computeUserQuota } from '../userQuota';

describe('computeUserQuota', () => {
  it('fresh user (0 applies, 0 reverts) → default 5/day, 5 remaining', () => {
    const r = computeUserQuota({
      lifetimeAutoApplies: 0,
      lifetimeReverts: 0,
      autoAppliesLast24h: 0,
    });
    expect(r.dailyCeiling).toBe(5);
    expect(r.remaining).toBe(5);
    expect(r.isPowerUser).toBe(false);
  });

  it('9 applies, 0 reverts → default tier (below threshold)', () => {
    const r = computeUserQuota({
      lifetimeAutoApplies: 9,
      lifetimeReverts: 0,
      autoAppliesLast24h: 0,
    });
    expect(r.dailyCeiling).toBe(5);
    expect(r.isPowerUser).toBe(false);
  });

  it('10 applies, 0 reverts → POWER tier (50/day)', () => {
    const r = computeUserQuota({
      lifetimeAutoApplies: 10,
      lifetimeReverts: 0,
      autoAppliesLast24h: 0,
    });
    expect(r.dailyCeiling).toBe(50);
    expect(r.remaining).toBe(50);
    expect(r.isPowerUser).toBe(true);
  });

  it('15 applies, 1 revert → demoted to default tier permanently', () => {
    const r = computeUserQuota({
      lifetimeAutoApplies: 15,
      lifetimeReverts: 1,
      autoAppliesLast24h: 0,
    });
    expect(r.dailyCeiling).toBe(5);
    expect(r.isPowerUser).toBe(false);
  });

  it('default user at 4/24h → 1 remaining', () => {
    const r = computeUserQuota({
      lifetimeAutoApplies: 0,
      lifetimeReverts: 0,
      autoAppliesLast24h: 4,
    });
    expect(r.remaining).toBe(1);
  });

  it('default user at 5/24h → 0 remaining', () => {
    const r = computeUserQuota({
      lifetimeAutoApplies: 0,
      lifetimeReverts: 0,
      autoAppliesLast24h: 5,
    });
    expect(r.remaining).toBe(0);
  });

  it('power user at 49/24h → 1 remaining', () => {
    const r = computeUserQuota({
      lifetimeAutoApplies: 20,
      lifetimeReverts: 0,
      autoAppliesLast24h: 49,
    });
    expect(r.dailyCeiling).toBe(50);
    expect(r.remaining).toBe(1);
  });

  it('power user at 50/24h → 0 remaining', () => {
    const r = computeUserQuota({
      lifetimeAutoApplies: 20,
      lifetimeReverts: 0,
      autoAppliesLast24h: 50,
    });
    expect(r.remaining).toBe(0);
  });

  it('over-quota is clamped at 0, not negative', () => {
    const r = computeUserQuota({
      lifetimeAutoApplies: 0,
      lifetimeReverts: 0,
      autoAppliesLast24h: 100,
    });
    expect(r.remaining).toBe(0);
  });
});
