// ── AES-256-GCM encryption helpers ───────────────────────────────────────────
// Used for encrypting per-tenant API credentials before DB storage.
//
// Storage format: base64(iv):base64(authTag):base64(ciphertext)
// The ENCRYPTION_KEY env var is a 64-character hex string (32 bytes).
// Generate with:  openssl rand -hex 32

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const hex = process.env.ENCRYPTION_KEY ?? '';
  if (hex.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
      'Generate with: openssl rand -hex 32'
    );
  }
  return Buffer.from(hex, 'hex');
}

export function encrypt(plaintext) {
  const key    = getKey();
  const iv     = randomBytes(12); // 96-bit IV — standard for GCM
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const body   = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${body.toString('base64')}`;
}

export function decrypt(stored) {
  const parts = (stored ?? '').split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted value — expected iv:authTag:ciphertext');
  const [ivB64, tagB64, bodyB64] = parts;
  const key     = getKey();
  const iv      = Buffer.from(ivB64,  'base64');
  const tag     = Buffer.from(tagB64, 'base64');
  const body    = Buffer.from(bodyB64,'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
