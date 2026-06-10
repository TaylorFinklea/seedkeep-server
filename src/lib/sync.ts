/**
 * Delta sync helpers shared across per-household routes.
 *
 * All per-household tables carry `updated_at` (epoch ms) and a nullable
 * `deleted_at`. Clients pull deltas with `?since=<updated_at_cursor>`;
 * the server returns rows whose `updated_at > since`, including soft-deleted
 * rows so the client can purge them locally.
 *
 * Cursor tiebreaker (contract decision 9, additive): rows that share one
 * `updated_at` millisecond can straddle a page boundary, and the strict
 * `updated_at > since` filter would skip the tied remainder forever. New
 * clients send `since_id` (the id of the last item of the previous page)
 * alongside `since`; the feed then uses the composite filter
 * `updated_at > since OR (updated_at = since AND id > since_id)` with a
 * deterministic `ORDER BY updated_at, id`. Every page emits `cursor_id`
 * (the last item's id) beside the existing `cursor` so the client can
 * resume mid-millisecond. Requests without `since_id` keep the legacy
 * strict-cursor behavior — old builds are unaffected.
 */

export interface DeltaQuery {
  since: number;
  /** Id tiebreaker for the composite cursor; null when the client didn't send one. */
  sinceId: string | null;
  limit: number;
}

const MAX_LIMIT = 500;

export function parseDeltaQuery(searchParams: URLSearchParams): DeltaQuery {
  const sinceRaw = searchParams.get('since');
  const sinceIdRaw = searchParams.get('since_id');
  const limitRaw = searchParams.get('limit');
  const since = sinceRaw ? Number(sinceRaw) : 0;
  const requested = limitRaw ? Number(limitRaw) : MAX_LIMIT;
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), MAX_LIMIT) : MAX_LIMIT;
  return {
    since: Number.isFinite(since) && since >= 0 ? since : 0,
    sinceId: sinceIdRaw ? sinceIdRaw : null,
    limit,
  };
}

/**
 * Build the cursor predicate for a delta feed's WHERE clause.
 *
 * `startIndex` is the 1-based positional-parameter index the clause's
 * first placeholder uses; the returned `params` append directly after the
 * caller's existing params. With a `since_id` the clause reuses the same
 * `$N` for both `updated_at` comparisons and consumes two params; without
 * one it is the legacy strict filter and consumes one.
 */
export function deltaCursorWhere(
  query: DeltaQuery,
  startIndex: number,
  cols: { updatedAt?: string; id?: string } = {},
): { clause: string; params: unknown[] } {
  const updatedAt = cols.updatedAt ?? 'updated_at';
  const id = cols.id ?? 'id';
  if (query.sinceId !== null) {
    return {
      clause: `(${updatedAt} > $${startIndex} OR (${updatedAt} = $${startIndex} AND ${id} > $${startIndex + 1}))`,
      params: [query.since, query.sinceId],
    };
  }
  return { clause: `${updatedAt} > $${startIndex}`, params: [query.since] };
}

export interface DeltaPayload<T> {
  items: T[];
  cursor: number;
  cursor_id: string | null;
  has_more: boolean;
}

export function buildDeltaPayload<T extends { updated_at: number }>(
  items: T[],
  query: DeltaQuery,
  // Feeds whose primary key isn't `id` (pet_departures) pass an accessor.
  idOf: (item: T) => string = (item) => (item as T & { id: string }).id,
): DeltaPayload<T> {
  const last = items.length > 0 ? items[items.length - 1] : undefined;
  return {
    items,
    cursor: last !== undefined ? last.updated_at : query.since,
    cursor_id: last !== undefined ? idOf(last) : query.sinceId,
    has_more: items.length >= query.limit,
  };
}
