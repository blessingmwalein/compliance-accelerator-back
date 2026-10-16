import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Authenticated, RequirePermission } from '../auth/access.decorators.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import { PageQueryDto } from '../common/pagination.js';
import {
  CreateInvitationDto,
  InvitationAcceptedDto,
  InvitationDto,
  InvitationPageDto,
  InvitationPreviewDto,
  InvitationTokenDto,
} from './invitations.dto.js';
import { InvitationsService } from './invitations.service.js';

/** Invitations of one organisation: managed by members who may create users. */
@ApiTags('invitations')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or the invitation does not exist.',
)
@Controller('organisations/:organisationId/invitations')
export class OrganisationInvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get()
  @RequirePermission('users.view')
  @ApiOperation({ operationId: 'listInvitations', summary: 'List the invitations (newest first)' })
  @ApiOkResponse({ type: InvitationPageDto })
  list(@Query() query: PageQueryDto): Promise<InvitationPageDto> {
    return this.invitations.list(query);
  }

  /** Invites an email address with a role and sends the invitation email. Only an Owner may invite an Owner. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('users.create')
  @ApiOperation({ operationId: 'createInvitation', summary: 'Invite someone by email' })
  @ApiCreatedResponse({ type: InvitationDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed.')
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`ALREADY_MEMBER` or `INVITATION_PENDING` for this address.',
  )
  create(@Body() dto: CreateInvitationDto): Promise<InvitationDto> {
    return this.invitations.create(dto);
  }

  /** Sends the email again with a fresh link (the previous link stops working). At most one email per 5 minutes. */
  @Post(':invitationId/resend')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('users.create')
  @ApiOperation({ operationId: 'resendInvitation', summary: 'Send an invitation again' })
  @ApiOkResponse({ type: InvitationDto })
  @ApiProblemResponse(HttpStatus.CONFLICT, 'The invitation is no longer pending.')
  resend(@Param('invitationId', ParseUUIDPipe) invitationId: string): Promise<InvitationDto> {
    return this.invitations.resend(invitationId);
  }

  @Post(':invitationId/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('users.create')
  @ApiOperation({ operationId: 'revokeInvitation', summary: 'Revoke a pending invitation' })
  @ApiOkResponse({ type: InvitationDto })
  @ApiProblemResponse(HttpStatus.CONFLICT, 'The invitation was already accepted.')
  revoke(@Param('invitationId', ParseUUIDPipe) invitationId: string): Promise<InvitationDto> {
    return this.invitations.revoke(invitationId);
  }
}

const TOKEN_LIMIT = { default: { limit: 20, ttl: 60_000 } };

/**
 * The invitee's side. The link in the email opens an SPA page that POSTs the token here (a GET link
 * handler would be consumed by mail scanners). The invitee is signed in but belongs to no organisation yet.
 */
@ApiTags('invitations')
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  /** What an invitation offers (organisation name and role), without accepting it. */
  @Post('inspect')
  @HttpCode(HttpStatus.OK)
  @Authenticated()
  @Throttle(TOKEN_LIMIT)
  @ApiOperation({
    operationId: 'inspectInvitation',
    summary: 'Look at an invitation before accepting',
  })
  @ApiOkResponse({ type: InvitationPreviewDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, '`INVALID_TOKEN`: unknown, expired, used or revoked.')
  @ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
  inspect(@Body() dto: InvitationTokenDto): Promise<InvitationPreviewDto> {
    return this.invitations.inspect(dto.token);
  }

  /** Accepts the invitation. The signed-in account must be the invited address with a confirmed email. */
  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @Authenticated()
  @Throttle(TOKEN_LIMIT)
  @ApiOperation({ operationId: 'acceptInvitation', summary: 'Accept an invitation' })
  @ApiOkResponse({ type: InvitationAcceptedDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, '`INVALID_TOKEN`: unknown, expired, used or revoked.')
  @ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
  @ApiProblemResponse(HttpStatus.FORBIDDEN, '`INVITATION_EMAIL_MISMATCH` or `EMAIL_NOT_VERIFIED`.')
  @ApiProblemResponse(HttpStatus.CONFLICT, '`ALREADY_MEMBER`.')
  accept(
    @Body() dto: InvitationTokenDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<InvitationAcceptedDto> {
    return this.invitations.accept(request.auth.userId, dto.token);
  }
}
