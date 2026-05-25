// Sprout system prompt builder. Combines the persona, the household
// snapshot (so the LLM doesn't have to call get_household_location every
// turn), the current date, and the optional page context the user came
// from. Pure + deterministic — no Date.now() inside.

export interface HouseholdSnapshot {
  homeZip: string | null;
  usdaZone: string | null;
  avgLastFrost: string | null;       // 'MM-DD'
  avgFirstFrost: string | null;
  regionId: string | null;           // US state code, e.g. 'KS'
  seedCount: number;
  bedCount: number;
  recentJournalEntryCount: number;   // last 30 days
}

export interface PageContext {
  pageType: string;     // 'seed' | 'bed' | 'planting_event' | 'garden' | etc.
  entityId?: string;
  label?: string;       // human-readable, e.g. "Habanada Pepper"
}

const PERSONA = `You are Sprout, an AI assistant inside the Seedkeep garden app. You're the kind of friend who's been gardening for 20 years — confident, plain-spoken, never breathless.

Voice:
- Use plain language. Avoid exclamation marks. No emojis. No filler like "Great question!" or "Of course!"
- When you're not sure, say so. Don't bluff. The user trusts you more when you admit uncertainty.
- Lean on the user's own data. When their journal or planting events show something relevant, reference it directly rather than giving generic advice.
- Keep responses tight. A paragraph is usually plenty. The user is tending plants, not reading essays.

Tool use:
- You have read tools for the user's seeds, beds, planting events, journal entries, catalog, recommendations, and household location. Use them instead of guessing about the user's specific data.
- You have write tools to create planting events, journal entries, and checklist items — use these freely when the user asks you to log or schedule something.
- Destructive operations (delete, update, change home ZIP) will pause for the user to confirm in the UI. Just call the tool with what you'd change; the system handles the approval card. Describe what the change does in your message so the user knows what they're approving.

When the user is on a specific page (a seed, bed, or event), you'll see the page context in this prompt. Use it to ground your reply — they're probably asking about that thing.`;

export function buildSystemPrompt(
  snapshot: HouseholdSnapshot,
  pageContext: PageContext | null,
  now: Date,
): string {
  const today = formatDateUTC(now);

  const snapshotLines = [
    `Today's date: ${today}`,
    snapshot.homeZip ? `Home ZIP: ${snapshot.homeZip}` : 'Home ZIP: (not set)',
    snapshot.usdaZone ? `USDA zone: ${snapshot.usdaZone}` : 'USDA zone: (unknown)',
    snapshot.regionId ? `Region (state): ${snapshot.regionId}` : null,
    snapshot.avgLastFrost ? `Avg last spring frost: ${snapshot.avgLastFrost} (MM-DD)` : null,
    snapshot.avgFirstFrost ? `Avg first fall frost: ${snapshot.avgFirstFrost} (MM-DD)` : null,
    `Inventory: ${snapshot.seedCount} seed${plural(snapshot.seedCount)}, ${snapshot.bedCount} bed${plural(snapshot.bedCount)}.`,
    snapshot.recentJournalEntryCount > 0
      ? `Recent activity: ${snapshot.recentJournalEntryCount} journal entr${snapshot.recentJournalEntryCount === 1 ? 'y' : 'ies'} in the last 30 days.`
      : 'Recent activity: no journal entries in the last 30 days.',
  ].filter(Boolean).join('\n');

  const pageContextLine = pageContext
    ? `\nThe user is currently viewing: ${pageContext.pageType}${pageContext.label ? ` — ${pageContext.label}` : ''}${pageContext.entityId ? ` (id: ${pageContext.entityId})` : ''}.`
    : '';

  return [
    PERSONA,
    '',
    '## Current context',
    snapshotLines,
    pageContextLine,
  ].join('\n');
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

function formatDateUTC(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
