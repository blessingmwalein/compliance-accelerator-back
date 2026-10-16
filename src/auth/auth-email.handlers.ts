import { Injectable } from '@nestjs/common';
import { JobHandler, type JobHandlerContract } from '../jobs/job-handler.js';
import { MailService } from '../mail/mail.service.js';
import {
  AUTH_JOB_TYPES,
  PASSWORD_RESET_TOKEN_TTL_MINUTES,
  SPA_PATHS,
  VERIFICATION_TOKEN_TTL_HOURS,
  type UserJobPayload,
} from './auth-jobs.js';
import { AuthLinkService } from './auth-link.service.js';
import { UsersRepository, type UserRecord } from './users.repository.js';

function userIdOf(payload: unknown): string {
  const userId = (payload as Partial<UserJobPayload> | null)?.userId;
  if (typeof userId !== 'string' || userId.length === 0)
    throw new Error('Malformed job payload: userId missing');
  return userId;
}

/**
 * The authentication emails. Each handler re-reads the user and re-checks the state before acting
 * (jobs are at-least-once): an unknown, deactivated or already-verified user simply ends the job.
 * Payloads carry the user id only; the address and links are produced here, at send time.
 */
abstract class AuthEmailHandler implements JobHandlerContract {
  protected constructor(protected readonly users: UsersRepository) {}

  async handle(payload: unknown): Promise<void> {
    const user = await this.users.findById(userIdOf(payload));
    if (!user || !user.isActive) return;
    await this.send(user);
  }

  protected abstract send(user: UserRecord): Promise<void>;
}

@Injectable()
@JobHandler(AUTH_JOB_TYPES.sendVerification)
export class SendVerificationHandler extends AuthEmailHandler {
  constructor(
    users: UsersRepository,
    private readonly links: AuthLinkService,
    private readonly mail: MailService,
  ) {
    super(users);
  }

  protected async send(user: UserRecord): Promise<void> {
    if (user.emailVerifiedAt) return;
    const link = await this.links.issue(
      user.id,
      'EMAIL_VERIFICATION',
      VERIFICATION_TOKEN_TTL_HOURS * 60 * 60 * 1000,
      SPA_PATHS.verifyEmail,
    );
    await this.mail.send({
      template: 'verify-email',
      to: user.email,
      link,
      expiresInHours: VERIFICATION_TOKEN_TTL_HOURS,
    });
  }
}

@Injectable()
@JobHandler(AUTH_JOB_TYPES.sendPasswordReset)
export class SendPasswordResetHandler extends AuthEmailHandler {
  constructor(
    users: UsersRepository,
    private readonly links: AuthLinkService,
    private readonly mail: MailService,
  ) {
    super(users);
  }

  protected async send(user: UserRecord): Promise<void> {
    const link = await this.links.issue(
      user.id,
      'PASSWORD_RESET',
      PASSWORD_RESET_TOKEN_TTL_MINUTES * 60 * 1000,
      SPA_PATHS.resetPassword,
    );
    await this.mail.send({
      template: 'password-reset',
      to: user.email,
      link,
      expiresInMinutes: PASSWORD_RESET_TOKEN_TTL_MINUTES,
    });
  }
}

@Injectable()
@JobHandler(AUTH_JOB_TYPES.sendAccountExists)
export class SendAccountExistsHandler extends AuthEmailHandler {
  constructor(
    users: UsersRepository,
    private readonly links: AuthLinkService,
    private readonly mail: MailService,
  ) {
    super(users);
  }

  protected async send(user: UserRecord): Promise<void> {
    await this.mail.send({
      template: 'account-exists',
      to: user.email,
      loginUrl: this.links.plain(SPA_PATHS.login),
      forgotPasswordUrl: this.links.plain(SPA_PATHS.forgotPassword),
    });
  }
}

@Injectable()
@JobHandler(AUTH_JOB_TYPES.sendPasswordChanged)
export class SendPasswordChangedHandler extends AuthEmailHandler {
  constructor(
    users: UsersRepository,
    private readonly links: AuthLinkService,
    private readonly mail: MailService,
  ) {
    super(users);
  }

  protected async send(user: UserRecord): Promise<void> {
    await this.mail.send({
      template: 'password-changed',
      to: user.email,
      loginUrl: this.links.plain(SPA_PATHS.login),
      forgotPasswordUrl: this.links.plain(SPA_PATHS.forgotPassword),
    });
  }
}
