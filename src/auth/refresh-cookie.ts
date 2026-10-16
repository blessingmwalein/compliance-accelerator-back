import type { Response } from 'express';
import type { AuthSettings } from './auth-settings.js';

export const REFRESH_COOKIE = 'fca_refresh';
/** Only the auth endpoints ever receive the refresh cookie. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
/** Custom header the SPA sends on cookie endpoints (CSRF defence together with the Origin check). */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'fca-web';

export function readRefreshCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== REFRESH_COOKIE) continue;
    try {
      const value = decodeURIComponent(part.slice(separator + 1).trim());
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function baseOptions(settings: AuthSettings) {
  return {
    httpOnly: true,
    secure: settings.cookie.secure,
    sameSite: 'lax' as const,
    path: REFRESH_COOKIE_PATH,
    ...(settings.cookie.domain ? { domain: settings.cookie.domain } : {}),
  };
}

export function setRefreshCookie(
  response: Response,
  token: string,
  maxAgeMs: number,
  settings: AuthSettings,
): void {
  response.cookie(REFRESH_COOKIE, token, { ...baseOptions(settings), maxAge: maxAgeMs });
}

export function clearRefreshCookie(response: Response, settings: AuthSettings): void {
  response.clearCookie(REFRESH_COOKIE, baseOptions(settings));
}
