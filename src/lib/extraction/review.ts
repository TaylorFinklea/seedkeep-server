/**
 * Reviewer pass — a second LLM call that critiques the vision extraction.
 *
 * The vision pass already self-rates. We don't trust that on its own.
 * The reviewer is given the extracted fields (no images) and asked: does
 * this look like a real seed-packet label? Are the fields internally
 * consistent? Are the names plausible?
 *
 * Why text-only? It's much cheaper than re-running vision and catches
 * the most common failure modes — hallucinated varieties, swapped
 * common_name and variety, planting instructions that are obviously
 * not seed-packet text.
 */

import type { ExtractionResult } from './anthropic';

export interface ReviewResult {
  // 0..1 — how plausible the extraction looks to the reviewer
  score: number;
  // Short notes the reviewer captured. Useful when the user inspects
  // a "needs review" entry.
  notes: string;
}

export interface ReviewInput {
  apiKey: string;
  model: string;
  extraction: ExtractionResult;
}

const SYSTEM_PROMPT = `You are a seed-catalog reviewer. You will be given a JSON object that another
model claims to have extracted from a seed-packet label. Your job is to judge how plausible
the extraction is on its own merits — without seeing the original images.

Score 0..1:
  1.00 — All fields look like real seed packet content. common_name is a real plant family/category.
         variety is a known cultivar or plausibly named one. company is a real seed company. instructions
         match real planting guidance. Internal consistency is high.
  0.70 — Mostly plausible. One field looks weak or generic (e.g. "Tomato seeds" as variety).
  0.40 — Plausible but suspect. common_name vs. variety might be swapped. Instructions look generic.
  0.10 — Looks hallucinated, illegible, or empty.

Return JSON only:

{
  "score": number,                // 0..1
  "notes": string                 // <= 200 chars, what made you pick that score
}`;

export async function reviewExtraction(input: ReviewInput): Promise<{ review: ReviewResult; raw: unknown }> {
  const body = {
    model: input.model,
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: JSON.stringify(input.extraction) }],
      },
    ],
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': input.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Anthropic review returned ${res.status}: ${await res.text()}`);
  }

  const raw = await res.json() as { content?: { type: string; text?: string }[] };
  const text = raw.content?.find((c) => c.type === 'text')?.text?.trim() ?? '';
  return { review: parseReview(text), raw };
}

function parseReview(text: string): ReviewResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { score: 0, notes: 'Reviewer output unparseable' };
  }
  const obj = parsed as Record<string, unknown>;
  const score = typeof obj.score === 'number' ? Math.min(1, Math.max(0, obj.score)) : 0;
  const notes = typeof obj.notes === 'string' ? obj.notes.slice(0, 240) : '';
  return { score, notes };
}
