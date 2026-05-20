// AI fallback for low-confidence planting windows. buildAiPrompt and
// parseAiBaseline are pure + tested; fetchAiBaseline is a thin Anthropic
// call mirroring src/lib/extraction/anthropic.ts.

import type { HouseholdLocation } from './engine';

export interface AiCatalogInput {
  commonName: string;
  variety: string | null;
  instructions: string | null;
}

export interface AiBaseline {
  windowStart: string | null;
  windowEnd: string | null;
  indoorStart: string | null;
  indoorEnd: string | null;
  confidence: number;
  reasoning: string;
  source: 'ai';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function buildAiPrompt(
  cat: AiCatalogInput,
  loc: HouseholdLocation,
  currentYear: number,
): string {
  return [
    'You are a horticulture expert. Compute a planting-window recommendation.',
    '',
    `Variety: ${cat.commonName}${cat.variety ? ` '${cat.variety}'` : ''}`,
    `Packet instructions: ${cat.instructions ?? '(none)'}`,
    '',
    `Location: USDA zone ${loc.usdaZone}.`,
    `Average last spring frost: ${loc.avgLastFrost} (MM-DD).`,
    `Average first fall frost: ${loc.avgFirstFrost} (MM-DD).`,
    `Current year: ${currentYear}.`,
    '',
    'Return ONLY a JSON object with these keys:',
    '  windowStart, windowEnd: "YYYY-MM-DD" — the outdoor plant-by window, or null',
    '  indoorStart, indoorEnd: "YYYY-MM-DD" — indoor seed-start window if transplanted, else null',
    '  confidence: number 0.0-1.0',
    '  reasoning: one or two sentences',
  ].join('\n');
}

function isValidDateOrNull(v: unknown): v is string | null {
  return v === null || (typeof v === 'string' && DATE_RE.test(v));
}

export function parseAiBaseline(text: string): AiBaseline | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      obj = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }

  if (
    !isValidDateOrNull(obj.windowStart) || !isValidDateOrNull(obj.windowEnd) ||
    !isValidDateOrNull(obj.indoorStart) || !isValidDateOrNull(obj.indoorEnd) ||
    typeof obj.confidence !== 'number' || typeof obj.reasoning !== 'string'
  ) {
    return null;
  }

  return {
    windowStart: obj.windowStart as string | null,
    windowEnd: obj.windowEnd as string | null,
    indoorStart: obj.indoorStart as string | null,
    indoorEnd: obj.indoorEnd as string | null,
    confidence: Math.max(0, Math.min(1, obj.confidence)),
    reasoning: obj.reasoning as string,
    source: 'ai',
  };
}

// Thin Anthropic call. Mirrors extractFromPhotos in extraction/anthropic.ts.
export async function fetchAiBaseline(
  apiKey: string,
  model: string,
  cat: AiCatalogInput,
  loc: HouseholdLocation,
  currentYear: number,
): Promise<AiBaseline | null> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      messages: [{ role: 'user', content: buildAiPrompt(cat, loc, currentYear) }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic recommendation call returned ${res.status}`);
  }
  const raw = (await res.json()) as { content?: { type: string; text?: string }[] };
  const textPart = raw.content?.find((p) => p.type === 'text')?.text ?? '';
  return parseAiBaseline(textPart);
}
