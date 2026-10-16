import { describe, expect, it } from 'vitest';
import { isDatabaseUnavailable } from './database-unavailable.js';

describe('isDatabaseUnavailable', () => {
  it.each(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2037'])(
    'recognises Prisma code %s',
    (code) => {
      expect(isDatabaseUnavailable(Object.assign(new Error('x'), { code }))).toBe(true);
    },
  );

  it.each([
    "Can't reach database server at dummy-endpoint-pooler.invalid",
    'Server has closed the connection.',
    'connect ECONNREFUSED 127.0.0.1:5432',
    'getaddrinfo ENOTFOUND dummy-endpoint.invalid',
    'Timed out fetching a new connection from the connection pool',
  ])('recognises the message %j', (message) => {
    expect(isDatabaseUnavailable(new Error(message))).toBe(true);
  });

  it('looks through the cause chain', () => {
    const inner = Object.assign(new Error('socket hang up'), { code: 'P1017' });
    expect(
      isDatabaseUnavailable(
        new Error('wrapper', { cause: new Error('wrapper 2', { cause: inner }) }),
      ),
    ).toBe(true);
  });

  it.each([
    ['a unique violation', Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })],
    [
      'a foreign key violation',
      Object.assign(new Error('Foreign key constraint violated'), { code: 'P2003' }),
    ],
    ['a plain bug', new TypeError("Cannot read properties of undefined (reading 'id')")],
    ['a non-error', 'ECONNREFUSED'],
    ['null', null],
    ['undefined', undefined],
  ])('does not mistake %s for an outage', (_name, error) => {
    expect(isDatabaseUnavailable(error)).toBe(false);
  });

  it('stops following a cyclic cause chain', () => {
    const a: { cause?: unknown; message: string } = { message: 'a' };
    a.cause = a;
    expect(isDatabaseUnavailable(a)).toBe(false);
  });
});
