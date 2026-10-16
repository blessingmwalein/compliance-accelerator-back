import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { AuthSettings } from './auth-settings.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './refresh-cookie.js';

/**
 * CSRF defence for the endpoints that act on the refresh cookie (`/auth/refresh`, `/auth/logout`).
 * Three layers: exact-origin CORS, an `Origin` header that must be one of the allowed origins when a
 * browser sends one, and a custom header (`X-Requested-With: fca-web`) that a cross-site form post
 * cannot set. SameSite=Lax on the cookie is the fourth.
 */
@Injectable()
export class CookieCsrfGuard implements CanActivate {
  constructor(private readonly settings: AuthSettings) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.headers[CSRF_HEADER] !== CSRF_HEADER_VALUE) {
      throw new AppException(
        ErrorCode.Forbidden,
        HttpStatus.FORBIDDEN,
        `Missing ${CSRF_HEADER} header.`,
      );
    }
    const origin = request.headers.origin;
    if (typeof origin === 'string' && !this.settings.allowedOrigins.includes(origin)) {
      throw new AppException(ErrorCode.Forbidden, HttpStatus.FORBIDDEN, 'Origin not allowed.');
    }
    return true;
  }
}
