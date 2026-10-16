import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { makeSettings } from '../../test/support/auth-fixtures.js';
import { CookieCsrfGuard } from './cookie-csrf.guard.js';

const guard = new CookieCsrfGuard(makeSettings({ CORS_ORIGINS: 'https://app.example.com' }));

const contextWith = (headers: Record<string, string>): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) }) as unknown as ExecutionContext;

const outcome = (headers: Record<string, string>) => {
  try {
    return guard.canActivate(contextWith(headers));
  } catch (error) {
    return `${(error as { code?: string }).code}: ${(error as { detail?: string }).detail}`;
  }
};

describe('CookieCsrfGuard', () => {
  it('accepts the custom header with no Origin (non-browser or same-origin client)', () => {
    expect(outcome({ 'x-requested-with': 'fca-web' })).toBe(true);
  });

  it('accepts the custom header with an allowed Origin', () => {
    expect(outcome({ 'x-requested-with': 'fca-web', origin: 'https://app.example.com' })).toBe(
      true,
    );
  });

  it('rejects a request without the custom header (a cross-site form post cannot set it)', () => {
    expect(outcome({})).toContain('FORBIDDEN');
    expect(outcome({ origin: 'https://app.example.com' })).toContain('FORBIDDEN');
  });

  it('rejects the wrong header value', () => {
    expect(outcome({ 'x-requested-with': 'XMLHttpRequest' })).toContain('FORBIDDEN');
  });

  it('rejects an Origin that is not allowed even when the header is present', () => {
    expect(
      outcome({ 'x-requested-with': 'fca-web', origin: 'https://evil.example.net' }),
    ).toContain('Origin not allowed');
    expect(outcome({ 'x-requested-with': 'fca-web', origin: 'null' })).toContain(
      'Origin not allowed',
    );
  });
});
