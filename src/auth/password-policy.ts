import { COMMON_PASSWORDS } from './common-passwords.js';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordProblem = 'tooShort' | 'tooLong' | 'tooCommon' | 'tooSimple' | 'containsEmail';

/**
 * Password rules (NIST SP 800-63B style): length over composition, no forced symbols, a denylist of
 * common passwords. Returns the problems found (empty = acceptable); the caller maps them to field
 * errors. `email` is optional so the same function serves reset (where it is known).
 *
 * LIMITATION: the denylist is a bundled sample of very common passwords, not a breached-password
 * service. Checking against a breach corpus (for example a k-anonymity range query) needs an external
 * call and is a deliberate later decision.
 */
export function checkPassword(password: string, email?: string): PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push('tooShort');
  if (password.length > PASSWORD_MAX_LENGTH) problems.push('tooLong');

  const normalised = password.trim().toLowerCase();
  if (COMMON_PASSWORDS.has(normalised)) problems.push('tooCommon');

  if (isRepeatedOrSequential(normalised)) problems.push('tooSimple');

  if (email) {
    const local = email.split('@')[0]?.toLowerCase();
    if (local && local.length >= 4 && normalised.includes(local)) problems.push('containsEmail');
  }
  return problems;
}

/** "aaaaaaaaaaaa", "abababababab", "123456789012", "abcdefghijkl": long strings with no real entropy. */
function isRepeatedOrSequential(value: string): boolean {
  if (value.length < 6) return false;
  if (new Set(value).size <= 2) return true;
  // Digit strings wrap around (…7890123…), so their differences are compared modulo 10.
  const modulus = /^\d+$/.test(value) ? 10 : 0;
  const diffOf = (i: number) => {
    const diff = value.charCodeAt(i) - value.charCodeAt(i - 1);
    return modulus ? ((diff % modulus) + modulus) % modulus : diff;
  };
  const step = diffOf(1);
  const stepIsOne = modulus ? step === 1 || step === modulus - 1 : step === 1 || step === -1;
  if (!stepIsOne) return false;
  for (let i = 2; i < value.length; i++) {
    if (diffOf(i) !== step) return false;
  }
  return true;
}
