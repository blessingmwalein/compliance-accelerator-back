import { Body, Controller, Get, HttpStatus, Put } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Authenticated, RequirePermission } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import { FrameworkDto, OrganisationFrameworkDto, SetFrameworksDto } from './frameworks.dto.js';
import { FrameworksService } from './frameworks.service.js';

/** The framework catalogue, the same for every organisation. */
@ApiTags('frameworks')
@Controller('frameworks')
export class FrameworksController {
  constructor(private readonly frameworks: FrameworksService) {}

  /** Identifiers only (code, name, jurisdiction): no legal text. Never a hard-coded list in a client. */
  @Get()
  @Authenticated()
  @ApiOperation({ operationId: 'listFrameworks', summary: 'The framework catalogue' })
  @ApiOkResponse({ type: FrameworkDto, isArray: true })
  @ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
  list(): Promise<FrameworkDto[]> {
    return this.frameworks.listCatalogue();
  }
}

/** Which frameworks this organisation declared applicable. */
@ApiTags('frameworks')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation (or it does not exist).',
)
@Controller('organisations/:organisationId/frameworks')
export class OrganisationFrameworksController {
  constructor(private readonly frameworks: FrameworksService) {}

  /** Every catalogue framework with whether it is applicable to this organisation. */
  @Get()
  @RequirePermission('company.view')
  @ApiOperation({
    operationId: 'listOrganisationFrameworks',
    summary: "The organisation's frameworks",
  })
  @ApiOkResponse({ type: OrganisationFrameworkDto, isArray: true })
  list(): Promise<OrganisationFrameworkDto[]> {
    return this.frameworks.list();
  }

  /** Sets the applicable frameworks to exactly the ids sent. A removed framework keeps its history. */
  @Put()
  @RequirePermission('company.edit')
  @ApiOperation({
    operationId: 'setOrganisationFrameworks',
    summary: 'Set the applicable frameworks',
  })
  @ApiOkResponse({ type: OrganisationFrameworkDto, isArray: true })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'A framework id is not in the catalogue.')
  set(@Body() dto: SetFrameworksDto): Promise<OrganisationFrameworkDto[]> {
    return this.frameworks.set(dto.frameworkIds);
  }
}
