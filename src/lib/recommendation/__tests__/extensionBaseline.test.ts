import { describe, it, expect } from 'vitest';
import { resolveExtensionBaseline } from '../extensionBaseline';
import type { ExtensionEntry } from '../extensionBaseline';

const DIRECT_ENTRY: ExtensionEntry = {
  windowStart: '04-15', windowEnd: '06-30',
  indoorStart: null, indoorEnd: null,
  sourceAttribution: 'Virginia Cooperative Extension',
};

describe('resolveExtensionBaseline', () => {
  it('resolves MM-DD windows to YYYY-MM-DD for the given year', () => {
    const b = resolveExtensionBaseline(DIRECT_ENTRY, 2026);
    expect(b.windowStart).toBe('2026-04-15');
    expect(b.windowEnd).toBe('2026-06-30');
  });

  it('confidence is 1.0 and source is extension', () => {
    const b = resolveExtensionBaseline(DIRECT_ENTRY, 2026);
    expect(b.confidence).toBe(1.0);
    expect(b.source).toBe('extension');
  });

  it('reasoning credits the source attribution', () => {
    const b = resolveExtensionBaseline(DIRECT_ENTRY, 2026);
    expect(b.reasoning).toBe('Per Virginia Cooperative Extension');
  });

  it('resolves an indoor window when present', () => {
    const b = resolveExtensionBaseline(
      { ...DIRECT_ENTRY, indoorStart: '02-15', indoorEnd: '03-15' }, 2026,
    );
    expect(b.indoorStart).toBe('2026-02-15');
    expect(b.indoorEnd).toBe('2026-03-15');
  });

  it('leaves indoor window null when the entry has none', () => {
    const b = resolveExtensionBaseline(DIRECT_ENTRY, 2026);
    expect(b.indoorStart).toBeNull();
    expect(b.indoorEnd).toBeNull();
  });
});
