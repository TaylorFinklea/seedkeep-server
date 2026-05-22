// Pure conversion of an extension_calendar_entries row (recurring MM-DD
// windows) into a dated baseline for currentYear. Shares the cache shape
// the route writes for rule/ai sources. An extension entry is
// authoritative: confidence is always 1.0, so it never triggers AI.

export interface ExtensionEntry {
  windowStart: string;        // 'MM-DD'
  windowEnd: string;          // 'MM-DD'
  indoorStart: string | null; // 'MM-DD'
  indoorEnd: string | null;
  sourceAttribution: string;
}

export interface ExtensionBaseline {
  windowStart: string;        // 'YYYY-MM-DD'
  windowEnd: string;
  indoorStart: string | null;
  indoorEnd: string | null;
  confidence: number;
  reasoning: string;
  source: 'extension';
}

function dateFor(year: number, mmdd: string): string {
  return `${year}-${mmdd}`;
}

export function resolveExtensionBaseline(
  entry: ExtensionEntry,
  currentYear: number,
): ExtensionBaseline {
  return {
    windowStart: dateFor(currentYear, entry.windowStart),
    windowEnd: dateFor(currentYear, entry.windowEnd),
    indoorStart: entry.indoorStart ? dateFor(currentYear, entry.indoorStart) : null,
    indoorEnd: entry.indoorEnd ? dateFor(currentYear, entry.indoorEnd) : null,
    confidence: 1.0,
    reasoning: `Per ${entry.sourceAttribution}`,
    source: 'extension',
  };
}
