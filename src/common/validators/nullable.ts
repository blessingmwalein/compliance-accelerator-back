import { Transform } from 'class-transformer';
import { ValidateIf } from 'class-validator';

/**
 * PATCH semantics for optional text fields: `undefined` = leave unchanged, `null` = clear. The other
 * validators on the property run only when a real value is sent.
 */
export const OptionalOrNull = () =>
  ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== null);

/** Trims text; a blank string becomes `null` (clear) so a cleared form field really clears the value. */
export const TrimToNull = () =>
  Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  });

/** Like `TrimToNull`, and lower-cases (email addresses are stored lower-case). */
export const EmailToNull = () =>
  Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim().toLowerCase();
    return trimmed === '' ? null : trimmed;
  });

/** Trims text but keeps it (a required field must not silently become null). */
export const TrimText = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));
