import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { OrganisationRequest } from '../access/organisation-request.js';
import { Authenticated, OrganisationMember } from '../auth/access.decorators.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import {
  CreateOrganisationDto,
  MyMembershipDto,
  OrganisationSummaryDto,
} from './organisations.dto.js';
import { OrganisationsService } from './organisations.service.js';

@ApiTags('organisations')
@Controller('organisations')
export class OrganisationsController {
  constructor(private readonly organisations: OrganisationsService) {}

  /** The organisations the signed-in user is an active member of, with their role in each. */
  @Get()
  @Authenticated()
  @ApiOperation({
    operationId: 'listMyOrganisations',
    summary: 'The organisations the signed-in user belongs to',
  })
  @ApiOkResponse({ type: OrganisationSummaryDto, isArray: true })
  @ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
  listMine(@Req() request: AuthenticatedRequest): Promise<OrganisationSummaryDto[]> {
    return this.organisations.listMine(request.auth.userId);
  }

  /**
   * Creates an organisation with the caller as its first Company Owner. Available only when the
   * deployment allows self-serve creation; otherwise a platform administrator provisions organisations.
   */
  @Post()
  @Authenticated()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    operationId: 'createOrganisation',
    summary: 'Create an organisation (self-serve)',
  })
  @ApiCreatedResponse({ type: OrganisationSummaryDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed.')
  @ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
  @ApiProblemResponse(
    HttpStatus.FORBIDDEN,
    'Self-serve creation is disabled (`SELF_SERVE_DISABLED`).',
  )
  create(
    @Body() dto: CreateOrganisationDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<OrganisationSummaryDto> {
    return this.organisations.createSelfServe(request.auth.userId, dto);
  }

  /** The caller's own membership in this organisation: role and every permission the role holds. */
  @Get(':organisationId/me')
  @OrganisationMember()
  @ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
  @ApiOperation({
    operationId: 'getMyMembership',
    summary: "The caller's role and permissions in an organisation",
  })
  @ApiOkResponse({ type: MyMembershipDto })
  @ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
  @ApiProblemResponse(
    HttpStatus.NOT_FOUND,
    'Not a member of this organisation (or it does not exist).',
  )
  getMyMembership(@Req() request: OrganisationRequest): MyMembershipDto {
    return this.organisations.describeMembership(
      request.params['organisationId'] as string,
      request.membership,
    );
  }
}
