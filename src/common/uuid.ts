import { randomBytes } from 'node:crypto';

/**
 * A UUIDv7 (RFC 9562): 48-bit Unix millisecond timestamp, then random bits. Prisma generates these
 * for `@default(uuid(7))` columns, but a few flows must know an id BEFORE the insert (a new organisation
 * is also the tenant of the transaction that creates it), so the same format is generated here.
 * Time order matters: keyset pagination and index locality rely on it.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const timestamp = nowMs.toString(16).padStart(12, '0').slice(-12);
  const random = randomBytes(10).toString('hex');
  const variant = ['8', '9', 'a', 'b'][Number.parseInt(random.charAt(4), 16) & 3];
  const hex = `${timestamp}7${random.slice(1, 4)}${variant}${random.slice(5, 8)}${random.slice(8, 20)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
