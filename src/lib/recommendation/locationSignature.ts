// Cache key for a household's location. Quantizes lat/lon to ~0.5-degree
// (~35-mile) buckets so nearby households share cached baselines.
//
// `regionId` (US state code or null) is appended so that adding extension-
// calendar coverage for a new region forces a cache miss for every household
// in that region — without it, pre-existing rule-engine rows for households
// already in (e.g.) KS would mask the new extension lookup forever.
// Cf. migration 0009's calendar-change trigger, which only invalidates by
// `recommendation_cache.region_id` and so misses pre-extension rows where
// that column is NULL. Signature inclusion is the belt to the trigger's
// suspenders: even if the trigger misses, signature mismatch produces a
// cache miss on the next request, and the lookup re-runs.

export function locationSignature(
  usdaZone: string,
  lat: number,
  lon: number,
  regionId: string | null = null,
): string {
  const q = (n: number) => (Math.round(n * 2) / 2).toFixed(1);
  return `${usdaZone}:${q(lat)},${q(lon)}:${regionId ?? 'none'}`;
}
