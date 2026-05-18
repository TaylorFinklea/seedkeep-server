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

export type SunRequirement = 'full' | 'partial' | 'shade';
export type FrostTolerance = 'tender' | 'half_hardy' | 'hardy';
export type SowMethod = 'direct' | 'transplant' | 'either';
export type LifeCycle = 'annual' | 'biennial' | 'perennial';

export interface ExtractionResult {
  // Identity
  common_name: string | null;
  scientific_name: string | null;
  variety: string | null;
  company: string | null;
  instructions: string | null;
  // Days-from-sowing ranges
  days_to_germinate_min: number | null;
  days_to_germinate_max: number | null;
  days_to_maturity_min: number | null;
  days_to_maturity_max: number | null;
  // Environmental requirements
  soil_temp_min_f: number | null;
  soil_temp_max_f: number | null;
  seed_depth_inches: number | null;
  plant_spacing_inches: number | null;
  row_spacing_inches: number | null;
  sun_requirement: SunRequirement | null;
  frost_tolerance: FrostTolerance | null;
  sow_method: SowMethod | null;
  life_cycle: LifeCycle | null;
  hardiness_zone_min: number | null;
  hardiness_zone_max: number | null;
  // Model's self-rating, 0..1, independent of the reviewer pass.
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
  "common_name": string | null,            // e.g. "Tomato", "Lettuce", "Basil"
  "scientific_name": string | null,        // binomial e.g. "Solanum lycopersicum"
  "variety": string | null,                // e.g. "Cherokee Purple", "Genovese"
  "company": string | null,                // brand/grower printed on the packet
  "instructions": string | null,           // condensed planting instructions, <= 600 chars, plain text, line breaks ok

  "days_to_germinate_min": int | null,     // sprouting time, lower bound in days
  "days_to_germinate_max": int | null,     // sprouting time, upper bound in days
  "days_to_maturity_min": int | null,      // days from sow/transplant to harvest, lower bound
  "days_to_maturity_max": int | null,      // days from sow/transplant to harvest, upper bound

  "soil_temp_min_f": int | null,           // ideal soil temp range, in Fahrenheit, lower bound
  "soil_temp_max_f": int | null,           // ideal soil temp range, in Fahrenheit, upper bound
  "seed_depth_inches": number | null,      // planting depth in inches (decimals ok, e.g. 0.25, 0.5, 1.0)
  "plant_spacing_inches": int | null,      // between plants, in inches
  "row_spacing_inches": int | null,        // between rows, in inches

  "sun_requirement": "full" | "partial" | "shade" | null,
  "frost_tolerance": "tender" | "half_hardy" | "hardy" | null,    // tender = killed by frost; half_hardy = light frost ok; hardy = tolerates freezes
  "sow_method": "direct" | "transplant" | "either" | null,        // packet's recommendation
  "life_cycle": "annual" | "biennial" | "perennial" | null,
  "hardiness_zone_min": int | null,        // USDA zone, 1..13
  "hardiness_zone_max": int | null,        // USDA zone, 1..13

  "self_confidence": number                // 0..1 — how confident YOU are the above fields are correct overall
}

Rules:
- Return null for any field not printed or clearly inferrable from the packet.
- Do not invent values. Don't guess scientific names; only return if printed.
- For ranges, if the packet shows a single number, use it for both min and max.
- For "Plant 1/4 inch deep" return seed_depth_inches: 0.25.
- For "Days to maturity: 75–80" return min: 75, max: 80.
- For "Full sun" / "Sun" / "6+ hours" return "full". "Partial sun" / "partial shade" → "partial". "Shade" / "full shade" → "shade".
- For frost: "frost tolerant"/"cold hardy"/"can be sown when frost is still possible" → "hardy". "Tender"/"after last frost" → "tender". Anything ambiguous → null.
- Output JSON only — no preamble, no explanation, no markdown fences.`;

export async function extractFromPhotos(input: VisionInput): Promise<{
  result: ExtractionResult;
  raw: unknown;
}> {
  const body = {
    model: input.model,
    max_tokens: 2048,
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

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  if (typeof v !== 'string') return null;
  const lower = v.trim().toLowerCase() as T;
  return allowed.includes(lower) ? lower : null;
}

function emptyResult(): ExtractionResult {
  return {
    common_name: null,
    scientific_name: null,
    variety: null,
    company: null,
    instructions: null,
    days_to_germinate_min: null,
    days_to_germinate_max: null,
    days_to_maturity_min: null,
    days_to_maturity_max: null,
    soil_temp_min_f: null,
    soil_temp_max_f: null,
    seed_depth_inches: null,
    plant_spacing_inches: null,
    row_spacing_inches: null,
    sun_requirement: null,
    frost_tolerance: null,
    sow_method: null,
    life_cycle: null,
    hardiness_zone_min: null,
    hardiness_zone_max: null,
    self_confidence: 0,
  };
}

function parseExtraction(text: string): ExtractionResult {
  const trimmed = text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
    }
  }
  if (!parsed || typeof parsed !== 'object') return emptyResult();
  const obj = parsed as Record<string, unknown>;

  return {
    common_name: asString(obj.common_name),
    scientific_name: asString(obj.scientific_name),
    variety: asString(obj.variety),
    company: asString(obj.company),
    instructions: asString(obj.instructions),
    days_to_germinate_min: asInt(obj.days_to_germinate_min),
    days_to_germinate_max: asInt(obj.days_to_germinate_max),
    days_to_maturity_min: asInt(obj.days_to_maturity_min),
    days_to_maturity_max: asInt(obj.days_to_maturity_max),
    soil_temp_min_f: asInt(obj.soil_temp_min_f),
    soil_temp_max_f: asInt(obj.soil_temp_max_f),
    seed_depth_inches: asNumber(obj.seed_depth_inches),
    plant_spacing_inches: asInt(obj.plant_spacing_inches),
    row_spacing_inches: asInt(obj.row_spacing_inches),
    sun_requirement: asEnum(obj.sun_requirement, ['full', 'partial', 'shade'] as const),
    frost_tolerance: asEnum(obj.frost_tolerance, ['tender', 'half_hardy', 'hardy'] as const),
    sow_method: asEnum(obj.sow_method, ['direct', 'transplant', 'either'] as const),
    life_cycle: asEnum(obj.life_cycle, ['annual', 'biennial', 'perennial'] as const),
    hardiness_zone_min: asInt(obj.hardiness_zone_min),
    hardiness_zone_max: asInt(obj.hardiness_zone_max),
    self_confidence: asNumber(obj.self_confidence) ?? 0,
  };
}
