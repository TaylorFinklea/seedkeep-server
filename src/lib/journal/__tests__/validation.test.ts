import { describe, it, expect } from 'vitest';
import { validateAtMostOneAttach } from '../validation';

describe('validateAtMostOneAttach', () => {
  it('accepts no attachment', () => {
    expect(validateAtMostOneAttach({}).ok).toBe(true);
    expect(validateAtMostOneAttach({ seed_id: null, bed_id: null, planting_event_id: null }).ok).toBe(true);
  });
  it('accepts exactly one attachment', () => {
    expect(validateAtMostOneAttach({ seed_id: 's1' }).ok).toBe(true);
    expect(validateAtMostOneAttach({ bed_id: 'b1' }).ok).toBe(true);
    expect(validateAtMostOneAttach({ planting_event_id: 'e1' }).ok).toBe(true);
  });
  it('rejects two attachments', () => {
    const r = validateAtMostOneAttach({ seed_id: 's1', bed_id: 'b1' });
    expect(r.ok).toBe(false);
  });
  it('rejects three attachments', () => {
    const r = validateAtMostOneAttach({ seed_id: 's1', bed_id: 'b1', planting_event_id: 'e1' });
    expect(r.ok).toBe(false);
  });
  it('treats empty string as unset', () => {
    expect(validateAtMostOneAttach({ seed_id: '', bed_id: 'b1' }).ok).toBe(true);
  });
});
