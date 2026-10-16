import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { Public } from './access.decorators.js';
import {
  AcceptedDto,
  AuthSessionDto,
  EmailOnlyDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from './auth.dto.js';
import { AuthService, type ClientInfo, type IssuedSession } from './auth.service.js';
import { AuthSettings } from './auth-settings.js';
import { CookieCsrfGuard } from './cookie-csrf.guard.js';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './refresh-cookie.js';

/** Stricter than the global per-IP limit: these are the endpoints an attacker would hammer. */
const AUTH_LIMIT = { default: { limit: 10, ttl: 60_000 } };
const REFRESH_LIMIT = { default: { limit: 30, ttl: 60_000 } };

const clientOf = (request: Request): ClientInfo => ({
  ip: request.ip,
  userAgent:
    typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined,
});

/**
 * Authentication endpoints (ADR-0003). Everything here is `@Public()`: it is how a caller becomes
 * authenticated. Responses that could reveal whether an address is registered are uniform (202).
 * Email links open SPA pages that POST the token here; the API never consumes a token on GET.
 */
@ApiTags('auth')
@Public()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly settings: AuthSettings,
  ) {}

  /** Creates an account and sends a confirmation email. Answers 202 whether or not the address is already registered. */
  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle(AUTH_LIMIT)
  @ApiOperation({ operationId: 'register', summary: 'Register an account' })
  @ApiAcceptedResponse({
    type: AcceptedDto,
    description: 'Accepted. A confirmation email is sent if appropriate.',
  })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (`password.*` codes describe weak passwords).',
  )
  @ApiProblemResponse(HttpStatus.TOO_MANY_REQUESTS, 'Rate limited.')
  async register(@Body() dto: RegisterDto, @Req() request: Request): Promise<AcceptedDto> {
    await this.auth.register(dto, clientOf(request));
    return { accepted: true };
  }

  /** Sends a new confirmation email to an unconfirmed account. Always 202. */
  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle(AUTH_LIMIT)
  @ApiOperation({ operationId: 'resendVerification', summary: 'Resend the confirmation email' })
  @ApiAcceptedResponse({
    type: AcceptedDto,
    description: 'Accepted, whatever the state of the account.',
  })
  @ApiProblemResponse(HttpStatus.TOO_MANY_REQUESTS, 'Rate limited.')
  async resendVerification(
    @Body() dto: EmailOnlyDto,
    @Req() request: Request,
  ): Promise<AcceptedDto> {
    await this.auth.resendVerification(dto.email, clientOf(request));
    return { accepted: true };
  }

  /** Confirms an email address with the one-time token from the email link (single use). */
  @Post('verify-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(AUTH_LIMIT)
  @ApiOperation({ operationId: 'verifyEmail', summary: 'Confirm an email address' })
  @ApiNoContentResponse({ description: 'The address is confirmed.' })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'The token is invalid, used or expired (`INVALID_TOKEN`).',
  )
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<void> {
    await this.auth.verifyEmail(dto.token);
  }

  /** Signs in. Returns the access token; the refresh token is set as an HttpOnly cookie scoped to `/api/v1/auth`. */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_LIMIT)
  @ApiOperation({ operationId: 'login', summary: 'Sign in' })
  @ApiOkResponse({ type: AuthSessionDto, description: 'Signed in.' })
  @ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Wrong email or password (`INVALID_CREDENTIALS`).')
  @ApiProblemResponse(
    HttpStatus.FORBIDDEN,
    'The email address is not confirmed yet (`EMAIL_NOT_VERIFIED`).',
  )
  @ApiProblemResponse(HttpStatus.TOO_MANY_REQUESTS, 'Too many failed attempts; see `Retry-After`.')
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthSessionDto> {
    const issued = await this.auth.login(dto, clientOf(request));
    return this.respondWithSession(response, issued);
  }

  /** Rotates the refresh cookie and returns a new access token. Needs the cookie and the `X-Requested-With: fca-web` header. */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CookieCsrfGuard)
  @Throttle(REFRESH_LIMIT)
  @ApiOperation({ operationId: 'refreshSession', summary: 'Refresh the session' })
  @ApiOkResponse({
    type: AuthSessionDto,
    description: 'A new access token; the refresh cookie was rotated.',
  })
  @ApiProblemResponse(
    HttpStatus.UNAUTHORIZED,
    'No, invalid, expired or reused refresh token. The cookie is cleared.',
  )
  @ApiProblemResponse(HttpStatus.FORBIDDEN, 'The CSRF header or the origin is missing or wrong.')
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthSessionDto> {
    try {
      const issued = await this.auth.refresh(
        readRefreshCookie(request.headers.cookie),
        clientOf(request),
      );
      return this.respondWithSession(response, issued);
    } catch (error) {
      if (error instanceof AppException && error.code === ErrorCode.Unauthenticated) {
        clearRefreshCookie(response, this.settings);
      }
      throw error;
    }
  }

  /** Ends the session of the refresh cookie and clears it. Always 204. */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(CookieCsrfGuard)
  @ApiOperation({ operationId: 'logout', summary: 'Sign out' })
  @ApiNoContentResponse({ description: 'Signed out (also when there was no session).' })
  @ApiProblemResponse(HttpStatus.FORBIDDEN, 'The CSRF header or the origin is missing or wrong.')
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(readRefreshCookie(request.headers.cookie));
    clearRefreshCookie(response, this.settings);
  }

  /** Sends a password-reset email if the account exists. Always 202. */
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle(AUTH_LIMIT)
  @ApiOperation({ operationId: 'forgotPassword', summary: 'Request a password reset' })
  @ApiAcceptedResponse({
    type: AcceptedDto,
    description: 'Accepted, whatever the state of the account.',
  })
  @ApiProblemResponse(HttpStatus.TOO_MANY_REQUESTS, 'Rate limited.')
  async forgotPassword(@Body() dto: EmailOnlyDto, @Req() request: Request): Promise<AcceptedDto> {
    await this.auth.forgotPassword(dto.email, clientOf(request));
    return { accepted: true };
  }

  /** Sets a new password with the one-time token from the email link, and ends every session of the account. */
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(AUTH_LIMIT)
  @ApiOperation({ operationId: 'resetPassword', summary: 'Choose a new password' })
  @ApiNoContentResponse({ description: 'The password was changed and every session ended.' })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed, or the token is invalid, used or expired.',
  )
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.auth.resetPassword(dto);
  }

  private respondWithSession(response: Response, issued: IssuedSession): AuthSessionDto {
    setRefreshCookie(response, issued.refreshToken, issued.refreshMaxAgeMs, this.settings);
    return {
      accessToken: issued.accessToken,
      tokenType: 'Bearer',
      expiresInSeconds: issued.expiresInSeconds,
    };
  }
}
