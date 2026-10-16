import { randomUUID } from 'node:crypto';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Inbound ids are only trusted when they look like an id (no log injection, bounded length). */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Returns the caller's `X-Request-Id` when it is well-formed, otherwise a fresh UUID. */
export function resolveRequestId(incoming: string | string[] | undefined): string {
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  return candidate !== undefined && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
}
