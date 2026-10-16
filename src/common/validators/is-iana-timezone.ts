import { registerDecorator, type ValidationOptions } from 'class-validator';

/**
 * True for an IANA time zone name such as `Africa/Harare` or `UTC`. Offsets (`+02:00`) and
 * abbreviations (`CAT`) are rejected: they do not follow daylight-saving rules, and deadline
 * arithmetic must run in a named zone.
 */
export function isIanaTimezone(value: unknown): boolean {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(value))
    return false;
  if (!value.includes('/') && value !== 'UTC') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function IsIanaTimezone(options?: ValidationOptions) {
  return (target: object, propertyName: string) => {
    registerDecorator({
      name: 'isIanaTimezone',
      target: target.constructor,
      propertyName,
      options: {
        message: `${propertyName} must be an IANA time zone such as Africa/Harare`,
        ...options,
      },
      validator: { validate: isIanaTimezone },
    });
  };
}
