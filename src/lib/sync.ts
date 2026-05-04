/**
 * Delta sync helpers shared across per-household routes.
 *
 * All per-household tables carry `updated_at` (epoch ms) and a nullable
 * `deleted_at`. Clients pull deltas with `?since=<updated_at_cursor>`;
 * the server returns rows whose `updated_at > since`, including soft-deleted
 * rows so the client can purge them locally.
 *
 * The `cursor` returned in the response is the max `updated_at` seen,
 * so the next pull only fetches truly new changes.
 */

export interface DeltaQuery {
  since: number;
  limit: number;
}

const MAX_LIMIT = 500;

export function parseDeltaQuery(searchParams: URLSearchParams): DeltaQuery {
  const sinceRaw = searchParams.get('since');
  const limitRaw = searchParams.get('limit');
  const since = sinceRaw ? Number(sinceRaw) : 0;
  const requested = limitRaw ? Number(limitRaw) : MAX_LIMIT;
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), MAX_LIMIT) : MAX_LIMIT;
  return {
    since: Number.isFinite(since) && since >= 0 ? since : 0,
    limit,
  };
}

export interface DeltaPayload<T> {
  items: T[];
  cursor: number;
  has_more: boolean;
}

export function buildDeltaPayload<T extends { updated_at: number }>(
  items: T[],
  query: DeltaQuery,
): DeltaPayload<T> {
  const lastUpdated = items.length > 0 ? items[items.length - 1].updated_at : query.since;
  return {
    items,
    cursor: lastUpdated,
    has_more: items.length >= query.limit,
  };
}
