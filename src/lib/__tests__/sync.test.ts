/**
 * Unit tests for the delta-sync cursor helpers (contract decision 9).
 *
 * The composite (updated_at, id) cursor is additive: `since_id` is
 * optional, and without it the legacy strict `updated_at > since`
 * behavior must be byte-for-byte preserved. `cursor_id` always rides
 * along in the payload so new clients can start sending the tiebreaker.
 */

import { describe, it, expect } from 'vitest';
import { parseDeltaQuery, deltaCursorWhere, buildDeltaPayload } from '../sync';

function qs(params: Record<string, string>): URLSearchParams {
  return new URLSearchParams(params);
}

describe('parseDeltaQuery — since_id', () => {
  it('defaults sinceId to null when absent', () => {
    const query = parseDeltaQuery(qs({ since: '100' }));
    expect(query.since).toBe(100);
    expect(query.sinceId).toBeNull();
  });

  it('treats an empty since_id as absent', () => {
    const query = parseDeltaQuery(qs({ since: '100', since_id: '' }));
    expect(query.sinceId).toBeNull();
  });

  it('passes a non-empty since_id through verbatim', () => {
    const query = parseDeltaQuery(qs({ since: '100', since_id: 'seed_local_abc' }));
    expect(query.sinceId).toBe('seed_local_abc');
  });
});

describe('deltaCursorWhere', () => {
  it('emits the legacy strict clause without since_id', () => {
    const query = parseDeltaQuery(qs({ since: '42' }));
    const cursor = deltaCursorWhere(query, 2);
    expect(cursor.clause).toBe('updated_at > $2');
    expect(cursor.params).toEqual([42]);
  });

  it('emits the composite clause with since_id', () => {
    const query = parseDeltaQuery(qs({ since: '42', since_id: 'row-b' }));
    const cursor = deltaCursorWhere(query, 2);
    expect(cursor.clause).toBe('(updated_at > $2 OR (updated_at = $2 AND id > $3))');
    expect(cursor.params).toEqual([42, 'row-b']);
  });

  it('honours custom column names and start index', () => {
    const query = parseDeltaQuery(qs({ since: '42', since_id: 'pe-1' }));
    const cursor = deltaCursorWhere(query, 5, { updatedAt: 'd.updated_at', id: 'planting_event_id' });
    expect(cursor.clause).toBe(
      '(d.updated_at > $5 OR (d.updated_at = $5 AND planting_event_id > $6))',
    );
    expect(cursor.params).toEqual([42, 'pe-1']);
  });
});

describe('buildDeltaPayload — cursor_id', () => {
  it("emits the last item's id as cursor_id", () => {
    const query = parseDeltaQuery(qs({ since: '0', limit: '10' }));
    const payload = buildDeltaPayload(
      [
        { id: 'a', updated_at: 1 },
        { id: 'b', updated_at: 2 },
      ],
      query,
    );
    expect(payload.cursor).toBe(2);
    expect(payload.cursor_id).toBe('b');
    expect(payload.has_more).toBe(false);
  });

  it('echoes since/since_id back on an empty page', () => {
    const query = parseDeltaQuery(qs({ since: '7', since_id: 'z' }));
    const payload = buildDeltaPayload([] as { id: string; updated_at: number }[], query);
    expect(payload.cursor).toBe(7);
    expect(payload.cursor_id).toBe('z');
  });

  it('cursor_id is null on an empty page without since_id (legacy clients)', () => {
    const query = parseDeltaQuery(qs({ since: '7' }));
    const payload = buildDeltaPayload([] as { id: string; updated_at: number }[], query);
    expect(payload.cursor_id).toBeNull();
  });

  it('uses the custom id accessor for feeds not keyed on `id`', () => {
    const query = parseDeltaQuery(qs({ since: '0', limit: '1' }));
    const payload = buildDeltaPayload(
      [{ planting_event_id: 'pe-9', updated_at: 5 }],
      query,
      (r) => r.planting_event_id,
    );
    expect(payload.cursor_id).toBe('pe-9');
    expect(payload.has_more).toBe(true);
  });
});
