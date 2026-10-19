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
import { OrganisationMember, RequirePermission } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import {
  ChangeRemediationTaskStatusDto,
  CommentRemediationTaskDto,
  CreateRemediationTaskDto,
  GeneratedRemediationTasksDto,
  GenerateRemediationTasksDto,
  ListRemediationTasksQueryDto,
  RemediationTaskDetailDto,
  RemediationTaskEventDto,
  RemediationTaskPageDto,
  UpdateRemediationTaskDto,
} from './remediation.dto.js';
import { RemediationService } from './remediation.service.js';

/**
 * Remediation tasks: the work an organisation raises from its assessed gaps.
 *
 * Access, and why it is where it is: the permission catalogue has ONE permission per decorator, while a
 * task's rule is per-role AND per-assignment (`remediation.updateOwn` only reaches the caller's own tasks).
 * So the read routes and the comment route declare `governance.view`, the two routes whose rule depends on
 * the task itself declare the loosest thing the catalogue can say (`@OrganisationMember()`), and the real
 * check runs in the service, which knows the row. Nothing is decided by the client.
 */
@ApiTags('remediation')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, 'This caller may not change this task.')
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or the remediation task does not exist.',
)
@Controller('organisations/:organisationId/remediation-tasks')
export class RemediationController {
  constructor(private readonly remediation: RemediationService) {}

  /** Cursor page, oldest task first (ids are UUIDv7). `overdue` is judged in the organisation's zone. */
  @Get()
  @RequirePermission('governance.view')
  @ApiOperation({ operationId: 'listRemediationTasks', summary: 'List the remediation tasks' })
  @ApiOkResponse({ type: RemediationTaskPageDto })
  list(@Query() query: ListRemediationTasksQueryDto): Promise<RemediationTaskPageDto> {
    return this.remediation.list(query);
  }

  /** A task raised by hand. Without a `dueDate` the task simply has no deadline. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('governance.create')
  @ApiOperation({ operationId: 'createRemediationTask', summary: 'Raise a remediation task' })
  @ApiCreatedResponse({ type: RemediationTaskDetailDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (unknown subject id, assignee who is not an active member).',
  )
  create(@Body() dto: CreateRemediationTaskDto): Promise<RemediationTaskDetailDto> {
    return this.remediation.create(dto);
  }

  /**
   * One task per gap of ONE assessment, in one transaction, with the priority the finding's risk level
   * gives it. Gaps that cannot be given a priority honestly, and subjects that already have an active
   * task, are returned in `skippedItems` with the reason. A re-run therefore changes nothing.
   */
  @Post('generate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('governance.create')
  @ApiOperation({
    operationId: 'generateRemediationTasks',
    summary: "Turn an assessment's gaps into tasks",
  })
  @ApiOkResponse({ type: GeneratedRemediationTasksDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed.')
  generate(@Body() dto: GenerateRemediationTasksDto): Promise<GeneratedRemediationTasksDto> {
    return this.remediation.generate(dto);
  }

  /** The task, its snapshot, its timeline, its evidence ids and the status steps THIS caller may take. */
  @Get(':taskId')
  @RequirePermission('governance.view')
  @ApiOperation({ operationId: 'getRemediationTask', summary: 'One remediation task' })
  @ApiOkResponse({ type: RemediationTaskDetailDto })
  get(@Param('taskId', ParseUUIDPipe) taskId: string): Promise<RemediationTaskDetailDto> {
    return this.remediation.get(taskId);
  }

  /**
   * Edit the task's own fields (`title`, `description`, `priority`, `assigneeMembershipId`, `dueDate`).
   * The decorator cannot express "an editor, or nothing", so the service refuses anyone without
   * `governance.edit` with 403 `NOT_ASSIGNEE`; a Standard User's own-task rights are comments and status
   * steps, not editing. The subject (assessment item, area, unit, framework) never changes.
   */
  @Patch(':taskId')
  @OrganisationMember()
  @ApiOperation({ operationId: 'updateRemediationTask', summary: 'Change a remediation task' })
  @ApiOkResponse({ type: RemediationTaskDetailDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed.')
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`: the task changed meanwhile.')
  update(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: UpdateRemediationTaskDto,
  ): Promise<RemediationTaskDetailDto> {
    return this.remediation.update(taskId, dto);
  }

  /**
   * Move the task along its lifecycle. Only the domain transition table decides whether the step exists
   * (otherwise 409 `INVALID_TRANSITION`, listing the steps that do); `COMPLETED → VERIFIED` and every
   * reopen need `governance.approve`, and a reopen needs a reason.
   */
  @Post(':taskId/status')
  @HttpCode(HttpStatus.OK)
  @OrganisationMember()
  @ApiOperation({
    operationId: 'changeRemediationTaskStatus',
    summary: "Change a task's status",
  })
  @ApiOkResponse({ type: RemediationTaskDetailDto })
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`INVALID_TRANSITION` (the step does not exist, or a reopen came without a reason) or `VERSION_CONFLICT`.',
  )
  changeStatus(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: ChangeRemediationTaskStatusDto,
  ): Promise<RemediationTaskDetailDto> {
    return this.remediation.changeStatus(taskId, dto);
  }

  /**
   * Add a note to the task's timeline. An editor may comment on any task; without `governance.edit` the
   * caller must hold `remediation.updateOwn` AND be the assignee of THIS task, which the service reads
   * from the row. The task itself does not change, so its `version` does not move.
   */
  @Post(':taskId/comments')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('governance.view')
  @ApiOperation({ operationId: 'commentRemediationTask', summary: 'Comment on a task' })
  @ApiOkResponse({ type: RemediationTaskDetailDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed (an empty or too long comment).')
  comment(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: CommentRemediationTaskDto,
  ): Promise<RemediationTaskDetailDto> {
    return this.remediation.comment(taskId, dto);
  }

  /** The timeline on its own, oldest first. Append-only: entries are never edited or removed. */
  @Get(':taskId/events')
  @RequirePermission('governance.view')
  @ApiOperation({ operationId: 'listRemediationTaskEvents', summary: "A task's timeline" })
  @ApiOkResponse({ type: RemediationTaskEventDto, isArray: true })
  events(@Param('taskId', ParseUUIDPipe) taskId: string): Promise<RemediationTaskEventDto[]> {
    return this.remediation.events(taskId);
  }
}
