import { describe, expect, it } from 'vitest';
import { signTick, TICK_PATH, TICK_TOLERANCE_SECONDS, verifyTick } from './tick-signature.js';

const SECRET = 'a-tick-secret-that-is-at-least-32-chars-long';
const NOW = new Date('2026-10-15T12:00:00Z');
const nowSeconds = Math.floor(NOW.getTime() / 1000);

const verify = (overrides: Partial<Parameters<typeof verifyTick>[0]> = {}) =>
  verifyTick({
    secret: SECRET,
    timestamp: String(nowSeconds),
    signature: signTick(SECRET, nowSeconds),
    now: NOW,
    ...overrides,
  });

describe('verifyTick', () => {
  it('accepts a correctly signed, fresh request', () => {
    expect(verify()).toBe(true);
  });

  it('rejects a missing or malformed timestamp or signature', () => {
    expect(verify({ timestamp: undefined })).toBe(false);
    expect(verify({ signature: undefined })).toBe(false);
    expect(verify({ timestamp: 'yesterday' })).toBe(false);
    expect(verify({ timestamp: '-1' })).toBe(false);
    expect(verify({ signature: '' })).toBe(false);
    expect(verify({ signature: 'zz' })).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    expect(
      verify({ signature: signTick('another-secret-another-secret-another', nowSeconds) }),
    ).toBe(false);
  });

  it('binds the signature to the timestamp and the path', () => {
    expect(verify({ timestamp: String(nowSeconds + 1) })).toBe(false);
    expect(verify({ signature: signTick(SECRET, nowSeconds, '/api/v1/other') })).toBe(false);
  });

  it('accepts the tolerance window and rejects beyond it (replay protection)', () => {
    const edge = nowSeconds - TICK_TOLERANCE_SECONDS;
    expect(verify({ timestamp: String(edge), signature: signTick(SECRET, edge) })).toBe(true);
    const stale = nowSeconds - TICK_TOLERANCE_SECONDS - 1;
    expect(verify({ timestamp: String(stale), signature: signTick(SECRET, stale) })).toBe(false);
    const future = nowSeconds + TICK_TOLERANCE_SECONDS + 1;
    expect(verify({ timestamp: String(future), signature: signTick(SECRET, future) })).toBe(false);
  });

  it('is case-insensitive about the hex signature', () => {
    expect(verify({ signature: signTick(SECRET, nowSeconds).toUpperCase() })).toBe(true);
  });

  it('signs the documented path', () => {
    expect(TICK_PATH).toBe('/api/v1/internal/jobs/tick');
  });
});
