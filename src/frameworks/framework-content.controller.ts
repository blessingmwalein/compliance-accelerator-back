import { Controller, Get, HttpStatus, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Authenticated } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import {
  FrameworkReferenceGuideDto,
  RequirementListQueryDto,
  RequirementPageDto,
} from './framework-content.dto.js';
import { FrameworkContentService } from './framework-content.service.js';

/** The Framework Reference Guide: what is loaded for each framework, and where it came from. */
@ApiTags('frameworks')
@Controller('frameworks')
export class FrameworkReferenceController {
  constructor(private readonly content: FrameworkContentService) {}

  /**
   * Every catalogue framework with its current verified version (source link, verifier, last reviewed date),
   * or `currentVersion: null` when nothing verified is loaded: say so, never fill the gap.
   */
  @Get('reference-guide')
  @Authenticated()
  @ApiOperation({
    operationId: 'getFrameworkReferenceGuide',
    summary: 'The framework reference guide',
  })
  @ApiOkResponse({ type: FrameworkReferenceGuideDto })
  @ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
  referenceGuide(): Promise<FrameworkReferenceGuideDto> {
    return this.content.referenceGuide();
  }
}

/** The requirement trees of loaded framework versions (identifiers and titles, never the operative text of a law). */
@ApiTags('frameworks')
@Controller('framework-versions')
export class FrameworkVersionsController {
  constructor(private readonly content: FrameworkContentService) {}

  @Get(':versionId/requirements')
  @Authenticated()
  @ApiOperation({
    operationId: 'listRequirements',
    summary: 'The requirements of a framework version',
  })
  @ApiParam({ name: 'versionId', type: String, format: 'uuid' })
  @ApiOkResponse({ type: RequirementPageDto })
  @ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
  @ApiProblemResponse(
    HttpStatus.NOT_FOUND,
    'The framework version does not exist or is not loaded.',
  )
  list(
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Query() query: RequirementListQueryDto,
  ): Promise<RequirementPageDto> {
    return this.content.listRequirements(versionId, query);
  }
}
