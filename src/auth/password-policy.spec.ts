import { describe, expect, it } from 'vitest';
import { checkPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password-policy.js';

describe('checkPassword', () => {
  it('accepts a long passphrase with no composition rules', () => {
    expect(checkPassword('correct-horse-purple-stapler')).toEqual([]);
    expect(checkPassword('only lowercase words here')).toEqual([]);
  });

  it('enforces the length boundaries exactly', () => {
    expect(checkPassword('x'.repeat(PASSWORD_MIN_LENGTH - 1) + 'q')).not.toContain('tooShort');
    expect(checkPassword('abcdefghijk')).toContain('tooShort'); // 11
    expect(checkPassword('b7Kd93mQw2Lp')).not.toContain('tooShort'); // 12
    expect(checkPassword('b7Kd93mQw2Lp'.repeat(11))).toContain('tooLong'); // 132 > 128
    expect(checkPassword('k'.repeat(PASSWORD_MAX_LENGTH))).not.toContain('tooLong');
  });

  it.each(['Password1234', 'QWERTYUIOP12', '  welcome123456  ', 'Fernando12345'])(
    'rejects the common password %j (case and surrounding spaces ignored)',
    (password) => {
      expect(checkPassword(password)).toContain('tooCommon');
    },
  );

  it.each(['aaaaaaaaaaaa', 'abababababab', '123456789012', 'abcdefghijkl', 'zyxwvutsrqpo'])(
    'rejects the low-entropy string %j',
    (password) => {
      expect(checkPassword(password)).toContain('tooSimple');
    },
  );

  it('rejects a password that contains the email name', () => {
    expect(checkPassword('maria.santos-2026!', 'maria.santos@example.com')).toContain(
      'containsEmail',
    );
    expect(checkPassword('purple-stapler-moon', 'maria.santos@example.com')).toEqual([]);
  });

  it('ignores very short email names (they would match everything)', () => {
    expect(checkPassword('an-ordinary-passphrase', 'an@example.com')).toEqual([]);
  });

  it('reports every problem at once so a form can show them together', () => {
    expect(checkPassword('aaaa')).toEqual(expect.arrayContaining(['tooShort']));
    expect(checkPassword('password')).toEqual(expect.arrayContaining(['tooShort']));
  });
});
