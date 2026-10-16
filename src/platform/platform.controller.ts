import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PlatformOnly } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import { PageQueryDto } from '../common/pagination.js';
import { AssignPlanDto, SubscriptionDto } from '../plans/plans.dto.js';
import {
  PlatformOrganisationPageDto,
  ProvisionedOrganisationDto,
  ProvisionOrganisationDto,
} from './platform.dto.js';
import { PlatformService } from './platform.service.js';

/**
 * Platform administration (ADR-0005): provisioning organisations. A platform administrator is NOT a
 * member of the organisations they provision and sees none of their records: only names and counts.
 */
@ApiTags('platform')
@PlatformOnly('platform.organisations.manage')
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, 'The caller is not a platform administrator.')
@Controller('platform/organisations')
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get()
  @ApiOperation({
    operationId: 'listPlatformOrganisations',
    summary: 'List every organisation (names and counts only)',
  })
  @ApiOkResponse({ type: PlatformOrganisationPageDto })
  list(@Query() query: PageQueryDto): Promise<PlatformOrganisationPageDto> {
    return this.platform.list(query);
  }

  /** Creates an organisation and invites the given address as its first Company Owner (an ordinary invitation). */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ operationId: 'provisionOrganisation', summary: 'Provision an organisation' })
  @ApiCreatedResponse({ type: ProvisionedOrganisationDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed.')
  provision(@Body() dto: ProvisionOrganisationDto): Promise<ProvisionedOrganisationDto> {
    return this.platform.provision(dto);
  }

  /** Assigns a plan: the organisation gets a snapshot of its limits (an unlimited plan lifts the user limit). */
  @Put(':organisationId/plan')
  @ApiOperation({ operationId: 'assignPlan', summary: 'Assign a plan to an organisation' })
  @ApiOkResponse({ type: SubscriptionDto })
  @ApiProblemResponse(HttpStatus.NOT_FOUND, 'No such organisation or plan.')
  assignPlan(
    @Param('organisationId', ParseUUIDPipe) organisationId: string,
    @Body() dto: AssignPlanDto,
  ): Promise<SubscriptionDto> {
    return this.platform.assignPlan(organisationId, dto.planId);
  }
}
