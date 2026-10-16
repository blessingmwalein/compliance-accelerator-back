/**
 * Brute-force policy for login (pure, so it is table-tested). Counters live in Postgres
 * (`login_attempts`) because an in-memory counter does not survive restarts or several instances.
 * Attempts are keyed on keyed hashes of the account and of the client IP: attempts against addresses
 * that do not exist are counted exactly like real ones, so lockout reveals nothing.
 */
export interface LockoutPolicy {
  /** Sliding window in which failures count. */
  windowSeconds: number;
  /** Failures for one account within the window before it is locked. */
  accountThreshold: number;
  /** Failures from one IP (any account) within the window before it is locked. */
  ipThreshold: number;
  /** First lock duration; doubles with every further failure beyond the threshold. */
  baseLockSeconds: number;
  maxLockSeconds: number;
}

export const DEFAULT_LOCKOUT_POLICY: LockoutPolicy = {
  windowSeconds: 15 * 60,
  accountThreshold: 5,
  ipThreshold: 30,
  baseLockSeconds: 30,
  maxLockSeconds: 15 * 60,
};

export interface LockoutDecision {
  locked: boolean;
  /** Seconds until another attempt is allowed (0 when not locked). */
  retryAfterSeconds: number;
}

export interface AttemptRecord {
  succeeded: boolean;
  attemptedAt: Date;
}

/** Failures after the most recent success, inside the window, oldest first. */
function recentFailures(
  attempts: readonly AttemptRecord[],
  now: Date,
  windowSeconds: number,
): Date[] {
  const since = now.getTime() - windowSeconds * 1000;
  const ordered = [...attempts].sort((a, b) => a.attemptedAt.getTime() - b.attemptedAt.getTime());
  const lastSuccess = ordered.reduce(
    (latest, attempt) => (attempt.succeeded ? attempt.attemptedAt.getTime() : latest),
    0,
  );
  return ordered
    .filter((attempt) => !attempt.succeeded)
    .map((attempt) => attempt.attemptedAt)
    .filter((at) => at.getTime() > since && at.getTime() > lastSuccess);
}

function lockFor(
  failures: Date[],
  threshold: number,
  now: Date,
  policy: LockoutPolicy,
): LockoutDecision {
  if (failures.length < threshold) return { locked: false, retryAfterSeconds: 0 };
  const excess = failures.length - threshold; // 0 for the failure that reached the threshold
  const lockSeconds = Math.min(
    policy.maxLockSeconds,
    policy.baseLockSeconds * 2 ** Math.min(excess, 20),
  );
  const lastFailure = failures[failures.length - 1]!;
  const remaining = Math.ceil((lastFailure.getTime() + lockSeconds * 1000 - now.getTime()) / 1000);
  return remaining > 0
    ? { locked: true, retryAfterSeconds: remaining }
    : { locked: false, retryAfterSeconds: 0 };
}

/** Locked if EITHER the account or the client IP has too many recent failures; the longer wait wins. */
export function evaluateLockout(
  input: {
    accountAttempts: readonly AttemptRecord[];
    ipAttempts: readonly AttemptRecord[];
    now: Date;
  },
  policy: LockoutPolicy = DEFAULT_LOCKOUT_POLICY,
): LockoutDecision {
  const account = lockFor(
    recentFailures(input.accountAttempts, input.now, policy.windowSeconds),
    policy.accountThreshold,
    input.now,
    policy,
  );
  const ip = lockFor(
    recentFailures(input.ipAttempts, input.now, policy.windowSeconds),
    policy.ipThreshold,
    input.now,
    policy,
  );
  return account.retryAfterSeconds >= ip.retryAfterSeconds ? account : ip;
}
