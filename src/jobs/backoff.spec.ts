import { describe, expect, it } from 'vitest';
import { backoffSeconds, sanitiseError } from './backoff.js';

const middle = () => 0.5; // jitter factor exactly 1

describe('backoffSeconds', () => {
  it('grows exponentially from 30 seconds', () => {
    expect([1, 2, 3, 4, 5].map((attempt) => backoffSeconds(attempt, middle))).toEqual([
      30, 60, 120, 240, 480,
    ]);
  });

  it('is capped at one hour', () => {
    expect(backoffSeconds(20, middle)).toBe(3600);
  });

  it('jitters by at most 20 percent either way', () => {
    expect(backoffSeconds(3, () => 0)).toBe(96); // 120 * 0.8
    expect(backoffSeconds(3, () => 0.999999)).toBe(144); // 120 * ~1.2
  });

  it('never returns less than one second, even for nonsense attempts', () => {
    expect(backoffSeconds(0, () => 0)).toBeGreaterThanOrEqual(1);
    expect(backoffSeconds(-5, () => 0)).toBeGreaterThanOrEqual(1);
  });
});

describe('sanitiseError', () => {
  it('removes email addresses and token-like strings', () => {
    const message = sanitiseError(
      new Error('SMTP rejected maria.santos@example.com with token ' + 'A'.repeat(43)),
    );
    expect(message).not.toContain('maria.santos');
    expect(message).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(message).toContain('[email]');
    expect(message).toContain('[token]');
  });

  it('keeps the error name and bounds the length', () => {
    expect(sanitiseError(new TypeError('boom'))).toBe('TypeError: boom');
    expect(sanitiseError('bad input '.repeat(100))).toHaveLength(300);
  });

  it('accepts anything that was thrown', () => {
    expect(sanitiseError(undefined)).toBe('undefined');
    expect(sanitiseError({ any: 'thing' })).toBe('[object Object]');
  });
});
