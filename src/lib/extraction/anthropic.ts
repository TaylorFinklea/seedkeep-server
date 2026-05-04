/**
 * Anthropic Claude vision call for seed-packet extraction.
 *
 * Prompt strategy: ask the model to read the printed packet and return a
 * compact JSON object with normalized fields. We tell it to output only
 * JSON so we can parse the response deterministically; if it adds prose,
 * we fall back to a JSON regex extract.
 *
 * Phase 1 uses a single model (DEFAULT_VISION_MODEL). Multi-provider
 * fallback is a Phase 2 concern.
 */

export interface ExtractionResult {
  common_name: string | null;
  variety: string | null;
  company: string | null;
  instructions: string | null;
  // 0..1 self-rated by the model. Independent from the reviewer score.
  self_confidence: number | null;
}

export interface VisionInput {
  apiKey: string;
  model: string;
  // Base64 (no data URL prefix) JPEG/PNG content for each side.
  frontBase64: string;
  backBase64: string;
}

const SYSTEM_PROMPT = `You are an expert at reading seed-packet labels.
You will be given two images: the front and back of a single seed packet.
Extract the seed information into a compact JSON object with EXACTLY these fields:

{
  "common_name": string | null,        // e.g. "Tomato", "Lettuce", "Basil"
  "variety": string | null,            // e.g. "Cherokee Purple", "Genovese"
  "company": string | null,            // brand/grower printed on the packet
  "instructions": string | null,       // condensed planting instructions, <= 600 chars, plain text, line breaks ok
  "self_confidence": number            // 0..1 — how confident YOU are the above fields are correct
}

If a field is illegible or absent, return null for that field. Do not invent values.
Output JSON only — no preamble, no explanation, no markdown fences.`;

export async function extractFromPhotos(input: VisionInput): Promise<{
  result: ExtractionResult;
  raw: unknown;
}> {
  const body = {
    model: input.model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: input.frontBase64 } },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: input.backBase64 } },
          { type: 'text', text: 'Front and back of the seed packet. Return the JSON.' },
        ],
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
    throw new Error(`Anthropic vision returned ${res.status}: ${await res.text()}`);
  }

  const raw = await res.json() as { content?: { type: string; text?: string }[] };
  const text = raw.content?.find((c) => c.type === 'text')?.text ?? '';
  return { result: parseExtraction(text), raw };
}

function parseExtraction(text: string): ExtractionResult {
  const trimmed = text.trim();
  // Try direct parse first; fall back to first {...} block.
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return {
      common_name: null,
      variety: null,
      company: null,
      instructions: null,
      self_confidence: 0,
    };
  }
  const obj = parsed as Record<string, unknown>;
  return {
    common_name: typeof obj.common_name === 'string' ? obj.common_name : null,
    variety: typeof obj.variety === 'string' ? obj.variety : null,
    company: typeof obj.company === 'string' ? obj.company : null,
    instructions: typeof obj.instructions === 'string' ? obj.instructions : null,
    self_confidence: typeof obj.self_confidence === 'number' ? obj.self_confidence : null,
  };
}
