// Pure validation: journal entries may attach to at most one of seed / bed /
// planting_event. The SQL CHECK catches violations at INSERT time, but doing
// it client-side first gives the route a clean { ok: false, code: 'bad_request',
// message: '...' } response instead of a 500 from a constraint violation.

export interface AttachInput {
  seed_id?: string | null;
  bed_id?: string | null;
  planting_event_id?: string | null;
}

export function validateAtMostOneAttach(input: AttachInput):
  | { ok: true }
  | { ok: false; reason: string } {
  const set = [input.seed_id, input.bed_id, input.planting_event_id]
    .filter((v) => v != null && v !== '').length;
  if (set <= 1) return { ok: true };
  return {
    ok: false,
    reason: 'journal entry may attach to at most one of seed, bed, or planting event',
  };
}
