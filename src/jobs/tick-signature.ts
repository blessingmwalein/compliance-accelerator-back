import { createHmac } from 'node:crypto';
import { safeEqual } from '../auth/tokens.js';

export const TICK_TIMESTAMP_HEADER = 'x-fca-timestamp';
export const TICK_SIGNATURE_HEADER = 'x-fca-signature';
export const TICK_PATH = '/api/v1/internal/jobs/tick';
export const TICK_TOLERANCE_SECONDS = 300;

/** `hex(HMAC-SHA256(secret, "<unix seconds>.POST.<path>"))`: what the host's cron job sends in X-FCA-Signature. */
export function signTick(
  secret: string,
  timestampSeconds: number,
  path: string = TICK_PATH,
): string {
  return createHmac('sha256', secret).update(`${timestampSeconds}.POST.${path}`).digest('hex');
}

/**
 * Verifies a tick request: a fresh timestamp (replay window of 5 minutes either way; a replay inside
 * the window only runs a bounded, idempotent batch again) and a constant-time signature match.
 */
export function verifyTick(input: {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  now: Date;
  path?: string;
}): boolean {
  if (!input.timestamp || !input.signature || !/^\d{1,12}$/.test(input.timestamp)) return false;
  const timestamp = Number(input.timestamp);
  const skew = Math.abs(Math.floor(input.now.getTime() / 1000) - timestamp);
  if (skew > TICK_TOLERANCE_SECONDS) return false;
  return safeEqual(
    signTick(input.secret, timestamp, input.path ?? TICK_PATH),
    input.signature.toLowerCase(),
  );
}
