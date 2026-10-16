import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCKOUT_POLICY, evaluateLockout, type AttemptRecord } from './lockout.js';

const NOW = new Date('2026-10-15T12:00:00Z');
const secondsAgo = (s: number): Date => new Date(NOW.getTime() - s * 1000);
const fail = (s: number): AttemptRecord => ({ succeeded: false, attemptedAt: secondsAgo(s) });
const ok = (s: number): AttemptRecord => ({ succeeded: true, attemptedAt: secondsAgo(s) });
const failures = (count: number, endingSecondsAgo = 1): AttemptRecord[] =>
  Array.from({ length: count }, (_, i) => fail(endingSecondsAgo + (count - 1 - i)));

const decide = (accountAttempts: AttemptRecord[], ipAttempts: AttemptRecord[] = []) =>
  evaluateLockout({ accountAttempts, ipAttempts, now: NOW });

describe('evaluateLockout', () => {
  it('allows attempts below the account threshold', () => {
    expect(decide(failures(4))).toEqual({ locked: false, retryAfterSeconds: 0 });
    expect(decide([])).toEqual({ locked: false, retryAfterSeconds: 0 });
  });

  it('locks at the threshold for the base duration, counted from the last failure', () => {
    // 5 failures, the last 1 s ago: 30 s lock, 29 s left
    expect(decide(failures(5, 1))).toEqual({ locked: true, retryAfterSeconds: 29 });
  });

  it('unlocks once the lock duration has passed', () => {
    expect(decide(failures(5, 31)).locked).toBe(false);
  });

  it('doubles the lock for every failure beyond the threshold, up to the maximum', () => {
    expect(decide(failures(6, 1))).toEqual({ locked: true, retryAfterSeconds: 59 }); // 60 s
    expect(decide(failures(7, 1))).toEqual({ locked: true, retryAfterSeconds: 119 }); // 120 s
    const huge = decide(failures(40, 1));
    expect(huge.retryAfterSeconds).toBeLessThanOrEqual(DEFAULT_LOCKOUT_POLICY.maxLockSeconds);
    expect(huge.retryAfterSeconds).toBeGreaterThan(DEFAULT_LOCKOUT_POLICY.maxLockSeconds - 5);
  });

  it('forgets failures outside the window', () => {
    const old = Array.from({ length: 10 }, (_, i) =>
      fail(DEFAULT_LOCKOUT_POLICY.windowSeconds + 60 + i),
    );
    expect(decide(old).locked).toBe(false);
  });

  it('a success resets the count: only failures AFTER the latest success count', () => {
    expect(decide([...failures(4, 120), ok(60), ...failures(4, 1)]).locked).toBe(false);
    expect(decide([ok(60), ...failures(5, 1)]).locked).toBe(true);
  });

  it('locks on the client IP independently of the account', () => {
    const ip = failures(DEFAULT_LOCKOUT_POLICY.ipThreshold, 1);
    expect(decide([], ip).locked).toBe(true);
    expect(decide([], failures(DEFAULT_LOCKOUT_POLICY.ipThreshold - 1)).locked).toBe(false);
  });

  it('returns the longer of the two waits', () => {
    const account = failures(5, 1); // 29 s
    const ip = failures(DEFAULT_LOCKOUT_POLICY.ipThreshold + 2, 1); // 4 x base = 120 s
    expect(decide(account, ip).retryAfterSeconds).toBeGreaterThan(100);
  });

  it('is independent of the order the attempts were read in', () => {
    const attempts = failures(5, 1);
    expect(decide([...attempts].reverse())).toEqual(decide(attempts));
  });
});
