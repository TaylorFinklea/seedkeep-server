import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptApiKey, decryptApiKey } from '../keyEncryption';

const MASTER = randomBytes(32).toString('base64');

describe('keyEncryption', () => {
  it('round-trips a typical Anthropic API key', () => {
    const plain = 'sk-ant-api03-' + 'x'.repeat(95);
    const enc = encryptApiKey(plain, MASTER);
    expect(decryptApiKey(enc, MASTER)).toBe(plain);
  });

  it('produces a fresh IV every call', () => {
    const plain = 'sk-ant-test';
    const a = encryptApiKey(plain, MASTER);
    const b = encryptApiKey(plain, MASTER);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('rejects tampered ciphertext', () => {
    const enc = encryptApiKey('sk-ant-x', MASTER);
    enc.ciphertext[0] ^= 0xff;
    expect(() => decryptApiKey(enc, MASTER)).toThrow();
  });

  it('rejects tampered auth tag', () => {
    const enc = encryptApiKey('sk-ant-x', MASTER);
    enc.tag[0] ^= 0xff;
    expect(() => decryptApiKey(enc, MASTER)).toThrow();
  });

  it('rejects a different master key', () => {
    const enc = encryptApiKey('sk-ant-x', MASTER);
    const other = randomBytes(32).toString('base64');
    expect(() => decryptApiKey(enc, other)).toThrow();
  });

  it('rejects a master key of wrong length', () => {
    expect(() => encryptApiKey('sk', 'too-short')).toThrow(/32 bytes/);
    // 31 bytes base64-encoded
    const wrongLen = randomBytes(31).toString('base64');
    expect(() => encryptApiKey('sk', wrongLen)).toThrow(/32 bytes/);
  });

  it('handles unicode keys', () => {
    const plain = 'sk-ant-🌱-test-éàü';
    const enc = encryptApiKey(plain, MASTER);
    expect(decryptApiKey(enc, MASTER)).toBe(plain);
  });

  it('produces a 12-byte IV and 16-byte tag', () => {
    const enc = encryptApiKey('test', MASTER);
    expect(enc.iv.length).toBe(12);
    expect(enc.tag.length).toBe(16);
  });
});
