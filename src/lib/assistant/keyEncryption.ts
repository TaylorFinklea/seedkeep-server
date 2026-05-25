// AES-256-GCM encryption for the user's BYOK API key. Master key comes
// from env `ASSISTANT_KEY_MASTER` (32 bytes after base64-decode).
//
// Each encryption call generates a fresh 12-byte IV. The 16-byte GCM auth
// tag is stored alongside the ciphertext so decryption can detect tampering
// or master-key rotation as a hard failure.
//
// Generate the master key with:  openssl rand -base64 32

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;     // AES-256
const IV_BYTES = 12;      // GCM standard
// Auth tag is 16 bytes by default for GCM; createCipheriv emits it via getAuthTag().

export interface EncryptedKey {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

function decodeMasterKey(masterKeyBase64: string): Buffer {
  const buf = Buffer.from(masterKeyBase64, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `ASSISTANT_KEY_MASTER must decode to exactly ${KEY_BYTES} bytes (got ${buf.length}). ` +
      `Generate with: openssl rand -base64 32`,
    );
  }
  return buf;
}

/**
 * Encrypt a plaintext API key with AES-256-GCM under the server master key.
 * Returns the ciphertext, IV, and auth tag — all of which must be stored
 * together to enable decryption.
 */
export function encryptApiKey(plaintext: string, masterKeyBase64: string): EncryptedKey {
  const masterKey = decodeMasterKey(masterKeyBase64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, masterKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

/**
 * Decrypt a previously-encrypted API key. Throws if the auth tag fails
 * verification (tamper detection) or the master key has been rotated.
 */
export function decryptApiKey(encrypted: EncryptedKey, masterKeyBase64: string): string {
  const masterKey = decodeMasterKey(masterKeyBase64);
  const decipher = createDecipheriv(ALGO, masterKey, encrypted.iv);
  decipher.setAuthTag(encrypted.tag);
  const plaintext = Buffer.concat([
    decipher.update(encrypted.ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
