import {
  Body,
  Controller,
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
  CreateMappingDto,
  LoadDefaultsResultDto,
  MappingListQueryDto,
  MappingMatrixDto,
  MappingMatrixQueryDto,
  MappingPageDto,
  MappingVersionDto,
  OrganisationMappingDto,
  UpdateMappingDto,
} from './compliance-mappings.dto.js';
import { ComplianceMappingsService } from './compliance-mappings.service.js';

/**
 * Compliance mappings of the organisation. Informative only: a mapping never establishes legal
 * equivalence, and the platform ships none that is not backed by a verified, cited source.
 */
@ApiTags('compliance-mappings')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or the mapping does not exist.',
)
@Controller('organisations/:organisationId/compliance-mappings')
export class ComplianceMappingsController {
  constructor(private readonly mappings: ComplianceMappingsService) {}

  @Get()
  @RequirePermission('mapping.view')
  @ApiOperation({ operationId: 'listMappings', summary: 'List the compliance mappings' })
  @ApiOkResponse({ type: MappingPageDto })
  list(@Query() query: MappingListQueryDto): Promise<MappingPageDto> {
    return this.mappings.list(query);
  }

  /** The mapping table: governance areas as rows, with the entries the client places in framework columns. */
  @Get('matrix')
  @RequirePermission('mapping.view')
  @ApiOperation({ operationId: 'getMappingMatrix', summary: 'The mapping table' })
  @ApiOkResponse({ type: MappingMatrixDto })
  matrix(@Query() query: MappingMatrixQueryDto): Promise<MappingMatrixDto> {
    return this.mappings.matrix(query);
  }

  /**
   * Copies the entries of the verified default packs for the applicable frameworks. Idempotent and
   * transactional; never overwrites a user's mapping. `422 SEED_DATA_UNAVAILABLE` (and no write) when no
   * verified pack exists.
   */
  @Post('load-defaults')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('mapping.loadDefaults')
  @ApiOperation({
    operationId: 'loadDefaultMappings',
    summary: 'Load the verified default mappings',
  })
  @ApiOkResponse({ type: LoadDefaultsResultDto })
  @ApiProblemResponse(
    HttpStatus.UNPROCESSABLE_ENTITY,
    '`SEED_DATA_UNAVAILABLE` (no verified pack for the applicable frameworks) or `NO_FRAMEWORKS_SELECTED`; nothing was written.',
  )
  loadDefaults(): Promise<LoadDefaultsResultDto> {
    return this.mappings.loadDefaults();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('mapping.edit')
  @ApiOperation({ operationId: 'createMapping', summary: 'Add a mapping' })
  @ApiCreatedResponse({ type: OrganisationMappingDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (unknown or unverified requirement, two requirements of one framework, unknown area).',
  )
  @ApiProblemResponse(HttpStatus.CONFLICT, '`MAPPING_ALREADY_EXISTS`.')
  create(@Body() dto: CreateMappingDto): Promise<OrganisationMappingDto> {
    return this.mappings.create(dto);
  }

  @Get(':mappingId')
  @RequirePermission('mapping.view')
  @ApiOperation({ operationId: 'getMapping', summary: 'A compliance mapping' })
  @ApiOkResponse({ type: OrganisationMappingDto })
  get(@Param('mappingId', ParseUUIDPipe) mappingId: string): Promise<OrganisationMappingDto> {
    return this.mappings.get(mappingId);
  }

  @Patch(':mappingId')
  @RequirePermission('mapping.edit')
  @ApiOperation({ operationId: 'updateMapping', summary: 'Change a mapping' })
  @ApiOkResponse({ type: OrganisationMappingDto })
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT` or `MAPPING_ALREADY_EXISTS`.')
  update(
    @Param('mappingId', ParseUUIDPipe) mappingId: string,
    @Body() dto: UpdateMappingDto,
  ): Promise<OrganisationMappingDto> {
    return this.mappings.update(mappingId, dto);
  }

  /** Archives the mapping: hidden from the table, kept for history. Idempotent. */
  @Post(':mappingId/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('mapping.edit')
  @ApiOperation({ operationId: 'archiveMapping', summary: 'Archive a mapping' })
  @ApiOkResponse({ type: OrganisationMappingDto })
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`: changed by someone else.')
  archive(
    @Param('mappingId', ParseUUIDPipe) mappingId: string,
    @Body() dto: MappingVersionDto,
  ): Promise<OrganisationMappingDto> {
    return this.mappings.archive(mappingId, dto);
  }

  @Post(':mappingId/unarchive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('mapping.edit')
  @ApiOperation({ operationId: 'unarchiveMapping', summary: 'Restore an archived mapping' })
  @ApiOkResponse({ type: OrganisationMappingDto })
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`VERSION_CONFLICT`, or the pair was mapped again meanwhile (`MAPPING_ALREADY_EXISTS`).',
  )
  unarchive(
    @Param('mappingId', ParseUUIDPipe) mappingId: string,
    @Body() dto: MappingVersionDto,
  ): Promise<OrganisationMappingDto> {
    return this.mappings.unarchive(mappingId, dto);
  }
}
