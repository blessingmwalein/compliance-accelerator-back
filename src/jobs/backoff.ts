const BASE_SECONDS = 30;
const MAX_SECONDS = 60 * 60;

/**
 * Seconds to wait before retrying after the `attempt`-th failure: exponential from 30 s, capped at
 * one hour, with up to +/-20 % jitter so a burst of failures does not retry in lockstep.
 * `random` is injectable (a number in [0, 1)) so tests are deterministic.
 */
export function backoffSeconds(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(MAX_SECONDS, BASE_SECONDS * 2 ** Math.max(0, attempt - 1));
  const jitter = 1 + (random() * 2 - 1) * 0.2;
  return Math.max(1, Math.round(exponential * jitter));
}

/** A failure message safe to store and log: no email addresses, no long token-like strings, bounded length. */
export function sanitiseError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[token]')
    .slice(0, 300);
}
