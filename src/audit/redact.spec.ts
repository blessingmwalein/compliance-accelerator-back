import { describe, expect, it } from 'vitest';
import { REDACTED, redactChanges } from './redact.js';

describe('redactChanges', () => {
  it('redacts sensitive keys at any depth and keeps the rest', () => {
    expect(
      redactChanges({
        name: { from: 'A', to: 'B' },
        password: 'hunter2',
        nested: { refreshToken: 'abc', keep: 1, list: [{ apiKey: 'k', ok: true }] },
        Authorization: 'Bearer x',
      }),
    ).toEqual({
      name: { from: 'A', to: 'B' },
      password: REDACTED,
      nested: { refreshToken: REDACTED, keep: 1, list: [{ apiKey: REDACTED, ok: true }] },
      Authorization: REDACTED,
    });
  });

  it.each([
    'password',
    'passwordHash',
    'secret',
    'clientSecret',
    'token',
    'cookie',
    'credentials',
    'otp',
    'signature',
  ])('treats %s as sensitive', (key) => {
    expect(redactChanges({ [key]: 'v' })).toEqual({ [key]: REDACTED });
  });

  it('serialises dates and does not mutate its input', () => {
    const input = { at: new Date('2026-10-15T10:00:00Z'), token: 't' };
    expect(redactChanges(input)).toEqual({ at: '2026-10-15T10:00:00.000Z', token: REDACTED });
    expect(input.token).toBe('t');
  });

  it('stops at a maximum depth instead of looping on a cyclic structure', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    expect(() => redactChanges(cyclic)).not.toThrow();
  });
});
