import { HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { AuthSettings } from './auth-settings.js';

/** The only claims in an access token: no role, no organisation (both are re-read from the database per request). */
export interface AccessTokenClaims {
  sub: string;
  sid: string;
}

/** Signs and verifies the short-lived access JWT (HS256, `sub` = user id, `sid` = session id). */
@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly settings: AuthSettings,
  ) {}

  sign(claims: AccessTokenClaims): Promise<string> {
    return this.jwt.signAsync(
      { sub: claims.sub, sid: claims.sid },
      {
        secret: this.settings.jwtSecret,
        algorithm: 'HS256',
        expiresIn: this.settings.accessTtlSeconds,
      },
    );
  }

  /** Throws a 401 `UNAUTHENTICATED` for anything that is not a valid, unexpired token signed with our secret. */
  async verify(token: string): Promise<AccessTokenClaims> {
    try {
      const payload = await this.jwt.verifyAsync<Partial<AccessTokenClaims>>(token, {
        secret: this.settings.jwtSecret,
        algorithms: ['HS256'],
      });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string')
        throw new Error('claims');
      return { sub: payload.sub, sid: payload.sid };
    } catch {
      throw new AppException(
        ErrorCode.Unauthenticated,
        HttpStatus.UNAUTHORIZED,
        'Invalid or expired access token.',
      );
    }
  }
}
