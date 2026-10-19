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
  ClassificationLevelDto,
  ClassificationLevelListQueryDto,
  ClassificationLevelPageDto,
  ClassificationLevelVersionDto,
  CreateClassificationLevelDto,
  UpdateClassificationLevelDto,
} from './classification.dto.js';
import { ClassificationService } from './classification.service.js';

/**
 * The organisation's data classification scheme. Levels are archived, never deleted, and a rank is never
 * reused — so a record classified years ago keeps its place in the order.
 */
@ApiTags('classification')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or the classification level does not exist.',
)
@Controller('organisations/:organisationId/classification-levels')
export class ClassificationController {
  constructor(private readonly levels: ClassificationService) {}

  @Get()
  @RequirePermission('data.view')
  @ApiOperation({
    operationId: 'listClassificationLevels',
    summary: 'List the classification levels',
  })
  @ApiOkResponse({ type: ClassificationLevelPageDto })
  list(@Query() query: ClassificationLevelListQueryDto): Promise<ClassificationLevelPageDto> {
    return this.levels.list(query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('data.create')
  @ApiOperation({ operationId: 'createClassificationLevel', summary: 'Add a classification level' })
  @ApiCreatedResponse({ type: ClassificationLevelDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed.')
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`CLASSIFICATION_LEVEL_NAME_TAKEN` or `CLASSIFICATION_RANK_TAKEN`.',
  )
  create(@Body() dto: CreateClassificationLevelDto): Promise<ClassificationLevelDto> {
    return this.levels.create(dto);
  }

  @Patch(':levelId')
  @RequirePermission('data.edit')
  @ApiOperation({
    operationId: 'updateClassificationLevel',
    summary: 'Change a classification level',
  })
  @ApiOkResponse({ type: ClassificationLevelDto })
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`VERSION_CONFLICT`, `CLASSIFICATION_LEVEL_NAME_TAKEN` or `CLASSIFICATION_RANK_TAKEN`.',
  )
  update(
    @Param('levelId', ParseUUIDPipe) levelId: string,
    @Body() dto: UpdateClassificationLevelDto,
  ): Promise<ClassificationLevelDto> {
    return this.levels.update(levelId, dto);
  }

  /** Archives the level: hidden from pickers, kept for history. Idempotent, and refused while records use it. */
  @Post(':levelId/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('data.delete')
  @ApiOperation({
    operationId: 'archiveClassificationLevel',
    summary: 'Archive a classification level',
  })
  @ApiOkResponse({ type: ClassificationLevelDto })
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`VERSION_CONFLICT`, or `RECORD_IN_USE`: records still sit at this level.',
  )
  archive(
    @Param('levelId', ParseUUIDPipe) levelId: string,
    @Body() dto: ClassificationLevelVersionDto,
  ): Promise<ClassificationLevelDto> {
    return this.levels.archive(levelId, dto);
  }

  @Post(':levelId/unarchive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('data.delete')
  @ApiOperation({
    operationId: 'unarchiveClassificationLevel',
    summary: 'Restore an archived classification level',
  })
  @ApiOkResponse({ type: ClassificationLevelDto })
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`, or the name was taken meanwhile.')
  unarchive(
    @Param('levelId', ParseUUIDPipe) levelId: string,
    @Body() dto: ClassificationLevelVersionDto,
  ): Promise<ClassificationLevelDto> {
    return this.levels.unarchive(levelId, dto);
  }
}
