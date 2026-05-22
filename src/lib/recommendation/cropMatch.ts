// Pure normalization of a catalog common_name into a crop-alias lookup
// key. Alias -> canonical crop_key resolution is a crop_aliases table
// lookup, not done here, so this stays a pure string function.

export function normalizeCropKey(commonName: string): string {
  return commonName.trim().toLowerCase().replace(/\s+/g, ' ');
}
