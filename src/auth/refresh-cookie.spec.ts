import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { makeSettings } from '../../test/support/auth-fixtures.js';
import {
  clearRefreshCookie,
  readRefreshCookie,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  setRefreshCookie,
} from './refresh-cookie.js';

describe('readRefreshCookie', () => {
  it('finds the refresh cookie among others', () => {
    expect(readRefreshCookie(`a=1; ${REFRESH_COOKIE}=tok_en-1; b=2`)).toBe('tok_en-1');
    expect(readRefreshCookie(`${REFRESH_COOKIE}=only`)).toBe('only');
  });

  it('ignores cookies with similar names', () => {
    expect(readRefreshCookie(`x_${REFRESH_COOKIE}=nope; ${REFRESH_COOKIE}x=nope`)).toBeUndefined();
  });

  it('returns undefined for a missing, empty or malformed cookie', () => {
    expect(readRefreshCookie(undefined)).toBeUndefined();
    expect(readRefreshCookie('')).toBeUndefined();
    expect(readRefreshCookie(`${REFRESH_COOKIE}=`)).toBeUndefined();
    expect(readRefreshCookie(`${REFRESH_COOKIE}=%E0%A4%A`)).toBeUndefined();
    expect(readRefreshCookie('garbage')).toBeUndefined();
  });
});

describe('refresh cookie attributes', () => {
  const fakeResponse = () =>
    ({ cookie: vi.fn(), clearCookie: vi.fn() }) as unknown as Response & {
      cookie: ReturnType<typeof vi.fn>;
      clearCookie: ReturnType<typeof vi.fn>;
    };

  it('is HttpOnly, SameSite=Lax, scoped to the auth path, with the configured max age', () => {
    const response = fakeResponse();
    setRefreshCookie(response, 'token', 12_345, makeSettings({ COOKIE_SECURE: true }));
    expect(response.cookie).toHaveBeenCalledWith(REFRESH_COOKIE, 'token', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: REFRESH_COOKIE_PATH,
      maxAge: 12_345,
    });
  });

  it('is not Secure when configured so (plain http on localhost)', () => {
    const response = fakeResponse();
    setRefreshCookie(response, 'token', 1, makeSettings({ COOKIE_SECURE: false }));
    expect(response.cookie.mock.calls[0]![2]).toMatchObject({ secure: false });
  });

  it('sets the domain only when configured', () => {
    const response = fakeResponse();
    setRefreshCookie(response, 'token', 1, makeSettings({ COOKIE_DOMAIN: 'example.com' }));
    expect(response.cookie.mock.calls[0]![2]).toMatchObject({ domain: 'example.com' });
    const plain = fakeResponse();
    setRefreshCookie(plain, 'token', 1, makeSettings());
    expect(plain.cookie.mock.calls[0]![2]).not.toHaveProperty('domain');
  });

  it('clears with the same path and attributes (otherwise the browser keeps the cookie)', () => {
    const response = fakeResponse();
    clearRefreshCookie(response, makeSettings({ COOKIE_DOMAIN: 'example.com' }));
    expect(response.clearCookie).toHaveBeenCalledWith(REFRESH_COOKIE, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: REFRESH_COOKIE_PATH,
      domain: 'example.com',
    });
  });
});
