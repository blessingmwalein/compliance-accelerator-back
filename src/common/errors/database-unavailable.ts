/**
 * Prisma error codes that mean "the database cannot be used right now" (as opposed to a bug or a
 * constraint violation): unreachable (P1001), timeout (P1002, P1008), connection closed (P1017),
 * connection pool timeout (P2024), too many connections (P2037).
 */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'P2024',
  'P2037',
]);

/** What a dropped, refused or unresolvable connection says, whichever layer reports it. */
const UNAVAILABLE_MESSAGE =
  /can't reach database server|server has closed the connection|connection terminated|connection refused|connect ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timed out fetching a new connection|remaining connection slots/i;

/**
 * True when `error` (or one of its causes) says the database is unreachable or out of connections.
 * Duck-typed on purpose: this module sits in `common/`, which must not import Prisma. Used by the
 * problem filter to answer 503 DATABASE_UNAVAILABLE instead of a generic 500, so a cold or
 * unreachable Neon compute shows clients a retryable state.
 */
export function isDatabaseUnavailable(error: unknown, depth = 0): boolean {
  if (typeof error !== 'object' || error === null || depth > 3) return false;
  const { code, message, cause } = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (typeof code === 'string' && UNAVAILABLE_CODES.has(code)) return true;
  if (typeof message === 'string' && UNAVAILABLE_MESSAGE.test(message)) return true;
  return isDatabaseUnavailable(cause, depth + 1);
}
