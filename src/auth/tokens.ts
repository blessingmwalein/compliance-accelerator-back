import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** An opaque 32-byte random token, base64url (43 characters). Only its SHA-256 is ever stored. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time string comparison (for secrets and signatures). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
