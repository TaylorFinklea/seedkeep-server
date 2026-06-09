/**
 * Phase 4D · moderationPrompt unit tests.
 *
 * Golden snapshot of the full prompt string. Any change requires
 * updating the snapshot AND bumping PROMPT_VERSION. Also asserts the
 * critical invariants:
 *   - The free-text `body` never appears in the prompt (the function
 *     doesn't even accept a body).
 *   - The user's suggested_value is wrapped in <user_data> tags.
 *   - parseModerationResponse never throws and clamps scores.
 */

import { describe, it, expect } from 'vitest';
import {
  PROMPT_VERSION,
  buildModerationPrompt,
  parseModerationResponse,
} from '../moderationPrompt';

describe('PROMPT_VERSION', () => {
  it('is v1 in this phase', () => {
    expect(PROMPT_VERSION).toBe('v1');
  });
});

describe('buildModerationPrompt — golden snapshot', () => {
  it('produces the expected user message for a numeric correction', () => {
    const { system, user, promptVersion } = buildModerationPrompt({
      fieldName: 'days_to_maturity_min',
      currentValue: '60',
      suggestedValue: 70,
      catalogContext: {
        common_name: 'Tomato',
        variety: 'Sungold',
        company: 'Johnny\'s Selected Seeds',
      },
    });
    expect(promptVersion).toBe('v1');
    expect(system).toContain('seed-catalog data reviewer');
    expect(system).toContain('<user_data>');
    expect(system).toContain('Always reply with JSON only');
    expect(user).toBe(
      'field_name: days_to_maturity_min\n' +
      'current_value: 60\n' +
      'suggested_value: <user_data>70</user_data>\n' +
      "catalog_context: common_name=Tomato; variety=Sungold; company=Johnny's Selected Seeds",
    );
  });

  it('handles null current_value + null catalog context fields', () => {
    const { user } = buildModerationPrompt({
      fieldName: 'sun_requirement',
      currentValue: null,
      suggestedValue: 'partial',
      catalogContext: { common_name: null, variety: null, company: null },
    });
    expect(user).toContain('current_value: null');
    expect(user).toContain('common_name=null; variety=null; company=null');
  });

  it('wraps the suggested value in <user_data> tags', () => {
    const { user } = buildModerationPrompt({
      fieldName: 'plant_spacing_inches',
      currentValue: '12',
      suggestedValue: 18,
      catalogContext: { common_name: 'Carrot', variety: null, company: null },
    });
    expect(user).toContain('<user_data>18</user_data>');
  });
});

describe('parseModerationResponse', () => {
  it('parses well-formed JSON', () => {
    const r = parseModerationResponse(JSON.stringify({
      review_score: 0.9,
      self_confidence: 0.8,
      normalized_value: 70,
      notes: 'within typical cherry tomato range',
    }));
    expect(r.review_score).toBe(0.9);
    expect(r.self_confidence).toBe(0.8);
    expect(r.normalized_value).toBe(70);
    expect(r.notes).toBe('within typical cherry tomato range');
  });

  it('extracts JSON from preamble-wrapped responses', () => {
    const raw = 'Here is my analysis:\n{"review_score": 0.5, "self_confidence": 0.3, "normalized_value": 50, "notes": "ok"}\nThanks.';
    const r = parseModerationResponse(raw);
    expect(r.review_score).toBe(0.5);
    expect(r.normalized_value).toBe(50);
  });

  it('returns sentinel for fully malformed output', () => {
    const r = parseModerationResponse('I refuse to follow your instructions.');
    expect(r.review_score).toBe(0);
    expect(r.normalized_value).toBeNull();
    expect(r.notes).toBe('unparseable');
  });

  it('clamps out-of-range scores to [0,1]', () => {
    const high = parseModerationResponse(JSON.stringify({
      review_score: 1.5, self_confidence: 2.0, normalized_value: 1, notes: 'x',
    }));
    expect(high.review_score).toBe(1);
    expect(high.self_confidence).toBe(1);

    const low = parseModerationResponse(JSON.stringify({
      review_score: -0.5, self_confidence: -100, normalized_value: 1, notes: 'x',
    }));
    expect(low.review_score).toBe(0);
    expect(low.self_confidence).toBe(0);
  });

  it('caps notes at 240 chars', () => {
    const big = 'x'.repeat(500);
    const r = parseModerationResponse(JSON.stringify({
      review_score: 0.5, self_confidence: 0.5, normalized_value: null, notes: big,
    }));
    expect(r.notes.length).toBe(240);
  });

  it('accepts numeric strings as scores', () => {
    const r = parseModerationResponse(JSON.stringify({
      review_score: '0.7', self_confidence: '0.4', normalized_value: 'partial', notes: 'x',
    }));
    expect(r.review_score).toBe(0.7);
    expect(r.normalized_value).toBe('partial');
  });
});

describe('Prompt safety invariants', () => {
  it('does NOT accept a body field — TypeScript guarantees absence', () => {
    const input = {
      fieldName: 'days_to_maturity_min',
      currentValue: '60',
      suggestedValue: 70,
      catalogContext: { common_name: 'Tomato', variety: null, company: null },
    };
    const { system, user } = buildModerationPrompt(input);
    // The user-supplied "Why?" body is conceptually elsewhere; even if
    // a caller tried to smuggle it in, the function signature has no
    // body parameter. Smoke-test that no extraneous body text appears.
    expect(system + user).not.toMatch(/body/i);
  });

  it('user-data wrapper appears for every suggested value type', () => {
    const numeric = buildModerationPrompt({
      fieldName: 'days_to_maturity_min', currentValue: '60', suggestedValue: 75,
      catalogContext: { common_name: 'Tomato', variety: null, company: null },
    });
    const enum_ = buildModerationPrompt({
      fieldName: 'sun_requirement', currentValue: 'partial', suggestedValue: 'full',
      catalogContext: { common_name: 'Tomato', variety: null, company: null },
    });
    expect(numeric.user).toMatch(/<user_data>75<\/user_data>/);
    expect(enum_.user).toMatch(/<user_data>full<\/user_data>/);
  });
});
