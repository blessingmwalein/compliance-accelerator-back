import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { MailModule } from '../mail/mail.module.js';
import { EntitlementsRepository } from './entitlements.repository.js';
import { EntitlementsService } from './entitlements.service.js';
import { SendInvitationHandler } from './invitation-email.handler.js';
import { InvitationTokenLookupRepository } from './invitation-token-lookup.repository.js';
import {
  InvitationsController,
  OrganisationInvitationsController,
} from './invitations.controller.js';
import { InvitationsRepository } from './invitations.repository.js';
import { InvitationsService } from './invitations.service.js';
import { MembersController } from './members.controller.js';
import { MembersService } from './members.service.js';
import { MembershipsRepository } from './memberships.repository.js';
import { OrganisationsController } from './organisations.controller.js';
import { OrganisationsRepository } from './organisations.repository.js';
import { OrganisationsService } from './organisations.service.js';
import { SubscriptionController } from './subscription.controller.js';

/** Organisations, their members and invitations (Phase 2c). */
@Module({
  imports: [AuthModule, AuditModule, JobsModule, MailModule],
  controllers: [
    OrganisationsController,
    MembersController,
    OrganisationInvitationsController,
    InvitationsController,
    SubscriptionController,
  ],
  providers: [
    OrganisationsRepository,
    MembershipsRepository,
    InvitationsRepository,
    InvitationTokenLookupRepository,
    OrganisationsService,
    MembersService,
    InvitationsService,
    SendInvitationHandler,
    EntitlementsRepository,
    EntitlementsService,
  ],
  exports: [OrganisationsService, EntitlementsService],
})
export class OrganisationsModule {}
