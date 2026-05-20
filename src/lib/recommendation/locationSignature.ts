// Cache key for a household's location. Quantizes lat/lon to ~0.5-degree
// (~35-mile) buckets so nearby households share cached baselines.

export function locationSignature(usdaZone: string, lat: number, lon: number): string {
  const q = (n: number) => (Math.round(n * 2) / 2).toFixed(1);
  return `${usdaZone}:${q(lat)},${q(lon)}`;
}
