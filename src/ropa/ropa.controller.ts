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
  CreateRopaActivityDto,
  LinkRopaEvidenceDto,
  ListRopaActivitiesQueryDto,
  RopaActivityDetailDto,
  RopaActivityDto,
  RopaActivityPageDto,
  RopaActivityVersionDto,
  RopaMonitorDto,
  UpdateRopaActivityDto,
} from './ropa.dto.js';
import { RopaService } from './ropa.service.js';

/**
 * The Record of Processing Activities. Activities are archived, never deleted, and a link to an evidence
 * file is a relation the organisation can undo without touching the file itself.
 */
@ApiTags('ropa')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or the processing activity does not exist.',
)
@Controller('organisations/:organisationId/ropa')
export class RopaController {
  constructor(private readonly ropa: RopaService) {}

  @Get()
  @RequirePermission('data.view')
  @ApiOperation({
    operationId: 'listRopaActivities',
    summary: 'List the processing activities',
  })
  @ApiOkResponse({ type: RopaActivityPageDto })
  list(@Query() query: ListRopaActivitiesQueryDto): Promise<RopaActivityPageDto> {
    return this.ropa.list(query);
  }

  /** Declared before `:activityId` so the word `monitor` is not read as an id. */
  @Get('monitor')
  @RequirePermission('data.view')
  @ApiOperation({
    operationId: 'getRopaMonitor',
    summary: 'How many processing activities need a review',
  })
  @ApiOkResponse({ type: RopaMonitorDto })
  monitor(): Promise<RopaMonitorDto> {
    return this.ropa.monitor();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('data.create')
  @ApiOperation({
    operationId: 'createRopaActivity',
    summary: 'Record a processing activity',
  })
  @ApiCreatedResponse({ type: RopaActivityDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (unknown subject id, archived level or rule, owner who is not an active member).',
  )
  create(@Body() dto: CreateRopaActivityDto): Promise<RopaActivityDto> {
    return this.ropa.create(dto);
  }

  @Get(':activityId')
  @RequirePermission('data.view')
  @ApiOperation({ operationId: 'getRopaActivity', summary: 'One processing activity' })
  @ApiOkResponse({ type: RopaActivityDetailDto })
  detail(@Param('activityId', ParseUUIDPipe) activityId: string): Promise<RopaActivityDetailDto> {
    return this.ropa.detail(activityId);
  }

  @Patch(':activityId')
  @RequirePermission('data.edit')
  @ApiOperation({ operationId: 'updateRopaActivity', summary: 'Change a processing activity' })
  @ApiOkResponse({ type: RopaActivityDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed.')
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`, or the activity is archived.')
  update(
    @Param('activityId', ParseUUIDPipe) activityId: string,
    @Body() dto: UpdateRopaActivityDto,
  ): Promise<RopaActivityDto> {
    return this.ropa.update(activityId, dto);
  }

  /** Archives the activity: hidden from the live register, kept for history. Idempotent. */
  @Post(':activityId/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('data.delete')
  @ApiOperation({ operationId: 'archiveRopaActivity', summary: 'Archive a processing activity' })
  @ApiOkResponse({ type: RopaActivityDto })
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`: changed by someone else.')
  archive(
    @Param('activityId', ParseUUIDPipe) activityId: string,
    @Body() dto: RopaActivityVersionDto,
  ): Promise<RopaActivityDto> {
    return this.ropa.archive(activityId, dto);
  }

  /** Restoring puts the line back as DRAFT: it is confirmed again before it counts as current. */
  @Post(':activityId/unarchive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('data.delete')
  @ApiOperation({
    operationId: 'unarchiveRopaActivity',
    summary: 'Restore an archived processing activity',
  })
  @ApiOkResponse({ type: RopaActivityDto })
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`: changed by someone else.')
  unarchive(
    @Param('activityId', ParseUUIDPipe) activityId: string,
    @Body() dto: RopaActivityVersionDto,
  ): Promise<RopaActivityDto> {
    return this.ropa.unarchive(activityId, dto);
  }

  /** Attaches an evidence file this organisation has uploaded. Linking the same file twice changes nothing. */
  @Post(':activityId/evidence')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('data.edit')
  @ApiOperation({ operationId: 'linkRopaEvidence', summary: 'Attach evidence to an activity' })
  @ApiOkResponse({ type: RopaActivityDetailDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, '`VALIDATION_FAILED`: the file is not one of ours.')
  link(
    @Param('activityId', ParseUUIDPipe) activityId: string,
    @Body() dto: LinkRopaEvidenceDto,
  ): Promise<RopaActivityDetailDto> {
    return this.ropa.linkEvidence(activityId, dto.evidenceId);
  }

  @Delete(':activityId/evidence/:evidenceId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('data.edit')
  @ApiOperation({
    operationId: 'unlinkRopaEvidence',
    summary: 'Detach evidence from an activity (the file itself stays)',
  })
  @ApiOkResponse({ type: RopaActivityDetailDto })
  unlink(
    @Param('activityId', ParseUUIDPipe) activityId: string,
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
  ): Promise<RopaActivityDetailDto> {
    return this.ropa.unlinkEvidence(activityId, evidenceId);
  }
}
