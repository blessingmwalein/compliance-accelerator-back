import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { Clock } from '../common/clock.js';
import { RequestContext } from '../tenancy/request-context.js';
import { AccessTokenService } from './access-token.service.js';
import { IS_PUBLIC_KEY } from './access.decorators.js';
import { SessionsRepository } from './sessions.repository.js';

/** What the guard attaches to the request for handlers that need the caller. */
export interface AuthenticatedRequest extends Request {
  auth: { userId: string; sessionId: string };
}

const bearerToken = (header: string | undefined): string | undefined => {
  const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header ?? '');
  return match?.[1];
};

/**
 * DENY BY DEFAULT: every route needs a valid access token unless it is explicitly `@Public()`.
 * The token only identifies a session; the session is re-read from the database on every request,
 * so a logout, a password reset or a deactivated user takes effect immediately, not when the token expires.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokenService,
    private readonly sessions: SessionsRepository,
    private readonly requestContext: RequestContext,
    private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      throw new AppException(
        ErrorCode.Unauthenticated,
        HttpStatus.UNAUTHORIZED,
        'Authentication required.',
      );
    }

    const claims = await this.accessTokens.verify(token);
    const active = await this.sessions.isActive(claims.sid, claims.sub, this.clock.now());
    if (!active) {
      throw new AppException(ErrorCode.Unauthenticated, HttpStatus.UNAUTHORIZED, 'Session ended.');
    }

    request.auth = { userId: claims.sub, sessionId: claims.sid };
    this.requestContext.update({ actorUserId: claims.sub, sessionId: claims.sid });
    return true;
  }
}
