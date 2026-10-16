import { describe, expect, it } from 'vitest';
import { isIanaTimezone } from './is-iana-timezone.js';

describe('isIanaTimezone', () => {
  it.each(['Africa/Harare', 'Europe/London', 'America/Argentina/Buenos_Aires', 'UTC'])(
    'accepts %s',
    (zone) => {
      expect(isIanaTimezone(zone)).toBe(true);
    },
  );

  it.each([
    '',
    'CAT',
    '+02:00',
    'Africa/Nowhere',
    'harare',
    'Africa/Harare; DROP TABLE',
    '../etc/passwd',
    'GMT+2',
    undefined,
    42,
    null,
  ])('rejects %s', (zone) => {
    expect(isIanaTimezone(zone)).toBe(false);
  });
});
