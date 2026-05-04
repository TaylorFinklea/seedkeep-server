import { describe, it, expect } from 'vitest';
import { decideCatalogStatus, type ConfidenceInput } from '../confidence';
import type { ExtractionResult } from '../anthropic';

const goodExtraction: ExtractionResult = {
  common_name: 'Tomato',
  variety: 'Cherokee Purple',
  company: 'Baker Creek',
  instructions: 'Sow indoors 6–8 weeks before last frost…',
  self_confidence: 0.9,
};

const baseInput = (overrides: Partial<ConfidenceInput>): ConfidenceInput => ({
  selfConfidence: 0.9,
  reviewScore: 0.9,
  extraction: goodExtraction,
  ...overrides,
});

describe('decideCatalogStatus (balanced policy)', () => {
  it('publishes when reviewScore≥0.85, selfConfidence≥0.70, common_name set', () => {
    const decision = decideCatalogStatus(baseInput({ reviewScore: 0.86, selfConfidence: 0.70 }));
    expect(decision.status).toBe('published');
  });

  it('does not publish when reviewScore is just under 0.85', () => {
    const decision = decideCatalogStatus(baseInput({ reviewScore: 0.84, selfConfidence: 0.95 }));
    expect(decision.status).toBe('pending');
  });

  it('does not publish when selfConfidence is below 0.70', () => {
    const decision = decideCatalogStatus(baseInput({ reviewScore: 0.95, selfConfidence: 0.60 }));
    expect(decision.status).toBe('pending');
  });

  it('treats null selfConfidence as zero (so cannot publish)', () => {
    const decision = decideCatalogStatus(baseInput({ reviewScore: 0.95, selfConfidence: null }));
    expect(decision.status).toBe('pending');
  });

  it('rejects when reviewScore is below 0.30', () => {
    const decision = decideCatalogStatus(baseInput({ reviewScore: 0.20 }));
    expect(decision.status).toBe('rejected');
  });

  it('rejects when all main fields are null even with high reviewScore', () => {
    const decision = decideCatalogStatus(
      baseInput({
        reviewScore: 0.99,
        selfConfidence: 0.99,
        extraction: { ...goodExtraction, common_name: null, variety: null, company: null },
      }),
    );
    expect(decision.status).toBe('rejected');
  });

  it('does not publish when common_name is null even with high scores', () => {
    const decision = decideCatalogStatus(
      baseInput({
        extraction: { ...goodExtraction, common_name: null },
      }),
    );
    // variety + company present so it's not "all null" → not rejected, but
    // common_name is required for publish → pending.
    expect(decision.status).toBe('pending');
  });

  it('reject reason includes the offending reviewScore', () => {
    const decision = decideCatalogStatus(baseInput({ reviewScore: 0.10 }));
    if (decision.status !== 'rejected') throw new Error('expected rejected');
    expect(decision.reason).toContain('0.10');
  });
});
