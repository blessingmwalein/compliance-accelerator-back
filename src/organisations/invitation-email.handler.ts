import { Injectable } from '@nestjs/common';
import { AuthSettings } from '../auth/auth-settings.js';
import { generateOpaqueToken, sha256Hex } from '../auth/tokens.js';
import { Clock } from '../common/clock.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { JobHandler, type JobHandlerContract } from '../jobs/job-handler.js';
import { MailService } from '../mail/mail.service.js';
import { ROLE_LABEL } from '../permissions/catalogue.js';
import {
  INVITATION_JOB_TYPES,
  INVITATION_SPA_PATH,
  INVITATION_TTL_DAYS,
  INVITATION_TTL_MS,
  type InvitationJobPayload,
} from './invitation-jobs.js';
import { InvitationsRepository } from './invitations.repository.js';
import { OrganisationsRepository } from './organisations.repository.js';

function parse(payload: unknown): InvitationJobPayload {
  const { organisationId, invitationId } = (payload ?? {}) as Partial<InvitationJobPayload>;
  if (typeof organisationId !== 'string' || typeof invitationId !== 'string') {
    throw new Error('Malformed job payload: organisationId and invitationId are required');
  }
  return { organisationId, invitationId };
}

/**
 * Sends the invitation email. The job runner already runs this inside the invitation's organisation
 * scope (the payload carries `organisationId`). The handler re-reads the invitation (jobs are
 * at-least-once: a revoked or accepted one simply ends the job), creates a FRESH one-time token and
 * stores only its SHA-256 (replacing any earlier one, so only the newest link works), commits, and only
 * then sends. If sending fails the job is retried and issues another token.
 */
@Injectable()
@JobHandler(INVITATION_JOB_TYPES.send)
export class SendInvitationHandler implements JobHandlerContract {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly invitations: InvitationsRepository,
    private readonly organisations: OrganisationsRepository,
    private readonly mail: MailService,
    private readonly settings: AuthSettings,
    private readonly clock: Clock,
  ) {}

  async handle(payload: unknown): Promise<void> {
    const { organisationId, invitationId } = parse(payload);
    const raw = generateOpaqueToken();

    const prepared = await this.uow.run(async (tx) => {
      const invitation = await this.invitations.findById(tx, invitationId);
      if (invitation?.status !== 'PENDING') return null;
      const organisation = await this.organisations.findById(tx, organisationId);
      if (!organisation) return null;
      const expiresAt = new Date(this.clock.now().getTime() + INVITATION_TTL_MS);
      if (!(await this.invitations.markSent(tx, invitation.id, sha256Hex(raw), expiresAt))) {
        return null;
      }
      return { to: invitation.email, role: invitation.role, organisationName: organisation.name };
    });
    if (!prepared) return;

    await this.mail.send({
      template: 'invitation',
      to: prepared.to,
      // The token is in the URL FRAGMENT: browsers never send it to a server.
      link: `${this.settings.appBaseUrl}${INVITATION_SPA_PATH}#token=${raw}`,
      organisationName: prepared.organisationName,
      roleLabel: ROLE_LABEL[prepared.role],
      expiresInDays: INVITATION_TTL_DAYS,
    });
  }
}
