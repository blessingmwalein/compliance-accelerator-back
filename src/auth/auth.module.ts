import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { EnvironmentVariables } from '../config/env.schema.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { MailModule } from '../mail/mail.module.js';
import { SecurityEventsModule } from '../security-events/security-events.module.js';
import { AccessTokenService } from './access-token.service.js';
import {
  SendAccountExistsHandler,
  SendPasswordChangedHandler,
  SendPasswordResetHandler,
  SendVerificationHandler,
} from './auth-email.handlers.js';
import { AuthLinkService } from './auth-link.service.js';
import { AccessGuard } from '../access/access.guard.js';
import { MembershipLookupRepository } from '../access/membership-lookup.repository.js';
import { AuthSettings } from './auth-settings.js';
import { AuthTokensRepository } from './auth-tokens.repository.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { CookieCsrfGuard } from './cookie-csrf.guard.js';
import { KeyedHasher } from './keyed-hasher.js';
import { LoginAttemptsRepository } from './login-attempts.repository.js';
import { MeController } from './me.controller.js';
import { PasswordService } from './password.service.js';
import { SessionsRepository } from './sessions.repository.js';
import { UsersRepository } from './users.repository.js';

@Module({
  imports: [
    // Secrets are passed per call (AccessTokenService), never as module-level defaults.
    JwtModule.register({}),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => ({
        // Coarse per-IP limit for every route; auth routes add a stricter @Throttle. In memory, so
        // per instance: the Postgres-backed login lockout is what holds across instances.
        throttlers: [
          { name: 'default', ttl: 60_000, limit: config.get('THROTTLE_LIMIT', { infer: true }) },
        ],
        skipIf: () => config.get('THROTTLE_ENABLED', { infer: true }) === false,
      }),
    }),
    JobsModule,
    MailModule,
    SecurityEventsModule,
  ],
  controllers: [AuthController, MeController],
  providers: [
    AuthSettings,
    KeyedHasher,
    PasswordService,
    AccessTokenService,
    UsersRepository,
    SessionsRepository,
    AuthTokensRepository,
    LoginAttemptsRepository,
    MembershipLookupRepository,
    AuthService,
    AuthLinkService,
    CookieCsrfGuard,
    SendVerificationHandler,
    SendPasswordResetHandler,
    SendAccountExistsHandler,
    SendPasswordChangedHandler,
    // Global guards run in this order: rate limit first (so a flood is cut before any database work),
    // then authentication (deny by default), then authorisation (platform flag, membership, permission).
    // test/guard-order.e2e-spec.ts proves the order by behaviour.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
  exports: [
    AuthSettings,
    AccessTokenService,
    SessionsRepository,
    UsersRepository,
    MembershipLookupRepository,
  ],
})
export class AuthModule {}
