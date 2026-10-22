import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import {
  CreateGovernanceAreaDto,
  GovernanceAreaDto,
  GovernanceAreaListQueryDto,
  GovernanceAreaPageDto,
  GovernanceAreaVersionDto,
  UpdateGovernanceAreaDto,
} from './governance-areas.dto.js';
import { GovernanceAreasService } from './governance-areas.service.js';

/** The organisation's governance areas (the rows of the compliance mapping table). Archived, never deleted. */
@ApiTags('governance-areas')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or the governance area does not exist.',
)
@Controller('organisations/:organisationId/governance-areas')
export class GovernanceAreasController {
  constructor(private readonly areas: GovernanceAreasService) {}

  @Get()
  @RequirePermission('mapping.view')
  @ApiOperation({ operationId: 'listGovernanceAreas', summary: 'List the governance areas' })
  @ApiOkResponse({ type: GovernanceAreaPageDto })
  list(@Query() query: GovernanceAreaListQueryDto): Promise<GovernanceAreaPageDto> {
    return this.areas.list(query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('mapping.edit')
  @ApiOperation({ operationId: 'createGovernanceArea', summary: 'Create a governance area' })
  @ApiCreatedResponse({ type: GovernanceAreaDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed, including `UNKNOWN_FRAMEWORK` when a reference cell names a framework that is not in the active catalogue; nothing was written.',
  )
  @ApiProblemResponse(HttpStatus.CONFLICT, '`GOVERNANCE_AREA_NAME_TAKEN`.')
  create(@Body() dto: CreateGovernanceAreaDto): Promise<GovernanceAreaDto> {
    return this.areas.create(dto);
  }

  @Patch(':areaId')
  @RequirePermission('mapping.edit')
  @ApiOperation({ operationId: 'updateGovernanceArea', summary: 'Change a governance area' })
  @ApiOkResponse({ type: GovernanceAreaDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed, including `UNKNOWN_FRAMEWORK`; a rejected cell list changes nothing.',
  )
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT` or `GOVERNANCE_AREA_NAME_TAKEN`.')
  update(
    @Param('areaId', ParseUUIDPipe) areaId: string,
    @Body() dto: UpdateGovernanceAreaDto,
  ): Promise<GovernanceAreaDto> {
    return this.areas.update(areaId, dto);
  }

  /** Archives the area: hidden from pickers, kept for history. Idempotent. */
  @Post(':areaId/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('mapping.edit')
  @ApiOperation({ operationId: 'archiveGovernanceArea', summary: 'Archive a governance area' })
  @ApiOkResponse({ type: GovernanceAreaDto })
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`: changed by someone else.')
  archive(
    @Param('areaId', ParseUUIDPipe) areaId: string,
    @Body() dto: GovernanceAreaVersionDto,
  ): Promise<GovernanceAreaDto> {
    return this.areas.archive(areaId, dto);
  }

  @Post(':areaId/unarchive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('mapping.edit')
  @ApiOperation({
    operationId: 'unarchiveGovernanceArea',
    summary: 'Restore an archived governance area',
  })
  @ApiOkResponse({ type: GovernanceAreaDto })
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`, or the name was taken meanwhile.')
  unarchive(
    @Param('areaId', ParseUUIDPipe) areaId: string,
    @Body() dto: GovernanceAreaVersionDto,
  ): Promise<GovernanceAreaDto> {
    return this.areas.unarchive(areaId, dto);
  }

  /**
   * Clears one row of the mapping table: its category, its control objective and every framework cell of
   * it. The area stays (archived, never deleted) and its verified requirement mappings stay — this route
   * removes only the text the organisation typed for itself. Clearing an empty row changes nothing.
   */
  @Delete(':areaId/mapping-sheet')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('mapping.edit')
  @ApiOperation({
    operationId: 'deleteMappingSheet',
    summary: 'Clear a row of the mapping table (the area and its mappings stay)',
  })
  @ApiOkResponse({ type: GovernanceAreaDto })
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`: changed by someone else.')
  deleteSheet(@Param('areaId', ParseUUIDPipe) areaId: string): Promise<GovernanceAreaDto> {
    return this.areas.deleteSheet(areaId);
  }
}
