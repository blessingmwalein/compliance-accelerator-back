/** Keys whose values never reach the audit trail, whatever the caller passes. */
const SENSITIVE_KEY =
  /pass(word|phrase)?|secret|token|authorization|cookie|api[-_]?key|credential|otp|hash|signature/i;

export const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

/**
 * Returns a deep copy of `value` with the values of sensitive keys replaced by `[REDACTED]`.
 * It is a safety net for secrets, not a privacy filter: callers still pass only field-level
 * before/after values of the data they changed, never free text from DSAR or breach records.
 * Anything nested deeper than 8 levels is replaced, so a cyclic or hostile structure cannot hang a request.
 */
export function redactChanges(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactChanges(item, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? REDACTED : redactChanges(item, depth + 1),
      ]),
    );
  }
  return value;
}
