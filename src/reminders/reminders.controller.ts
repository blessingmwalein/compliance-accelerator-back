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
  ChangeReminderStatusDto,
  CreateReminderDto,
  ListRemindersQueryDto,
  ReminderDto,
  ReminderPageDto,
  ReminderPreferencesDto,
  UpdateReminderDto,
  UpdateReminderPreferencesDto,
} from './reminders.dto.js';
import { RemindersService } from './reminders.service.js';

/**
 * The reminder ledger and each member's own email choices (AC-REMD-01).
 *
 * Reading the ledger and writing it are the two `reminders` permissions; settling one is a per-row rule —
 * the assignee or a reminder manager — so that route declares `@OrganisationMember()` and the service,
 * which has the row, decides. Preferences are nobody's permission but the member's own
 * (`notifications.own`): a member cannot read or change another member's choices, and the route does not
 * even take a membership id. Nothing here deletes a reminder: it ends its life DONE or CANCELLED.
 *
 * `preferences` is a static segment and is declared before `:reminderId`, so the word is never parsed as a
 * UUID.
 */
@ApiTags('reminders')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or the reminder does not exist.',
)
@Controller('organisations/:organisationId/reminders')
export class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  @Get()
  @RequirePermission('reminders.view')
  @ApiOperation({ operationId: 'listReminders', summary: 'List the reminder ledger' })
  @ApiOkResponse({ type: ReminderPageDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (a filter or a cursor is malformed).',
  )
  list(@Query() query: ListRemindersQueryDto): Promise<ReminderPageDto> {
    return this.reminders.list(query);
  }

  /**
   * A new reminder: PENDING, assigned to an ACTIVE member, with its due-soon and overdue alerts queued in
   * the same transaction that wrote the date.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('reminders.manage')
  @ApiOperation({ operationId: 'createReminder', summary: 'Add a reminder' })
  @ApiCreatedResponse({ type: ReminderDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (a date that is not a calendar day, an assignee who is not an active member, a source id without its kind).',
  )
  create(@Body() dto: CreateReminderDto): Promise<ReminderDto> {
    return this.reminders.create(dto);
  }

  @Get('preferences')
  @RequirePermission('notifications.own')
  @ApiOperation({
    operationId: 'getReminderPreferences',
    summary: "The signed-in member's own reminder email choices",
  })
  @ApiOkResponse({ type: ReminderPreferencesDto })
  preferences(): Promise<ReminderPreferencesDto> {
    return this.reminders.preferences();
  }

  /**
   * Omit a choice to keep it. Nothing is stored until the first save: until then the member hears about both
   * thresholds, because `REMINDER_PREFERENCE_DEFAULTS` are on.
   */
  @Patch('preferences')
  @RequirePermission('notifications.own')
  @ApiOperation({
    operationId: 'updateReminderPreferences',
    summary: "Change the signed-in member's own reminder email choices",
  })
  @ApiOkResponse({ type: ReminderPreferencesDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (a choice that is neither on nor off, a missing version).',
  )
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`VERSION_CONFLICT`: the choices, or the row itself, came into being since they were read.',
  )
  updatePreferences(@Body() dto: UpdateReminderPreferencesDto): Promise<ReminderPreferencesDto> {
    return this.reminders.updatePreferences(dto);
  }

  @Get(':reminderId')
  @RequirePermission('reminders.view')
  @ApiOperation({ operationId: 'getReminder', summary: 'One reminder' })
  @ApiOkResponse({ type: ReminderDto })
  get(@Param('reminderId', ParseUUIDPipe) reminderId: string): Promise<ReminderDto> {
    return this.reminders.get(reminderId);
  }

  /**
   * Content, assignee and due date of a reminder that is still PENDING. A moved date re-queues the alerts for
   * the new day; the rows already queued stay on the ledger and prove the change when they skip themselves.
   */
  @Patch(':reminderId')
  @RequirePermission('reminders.manage')
  @ApiOperation({ operationId: 'updateReminder', summary: 'Change a reminder' })
  @ApiOkResponse({ type: ReminderDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (a cleared title or date, an assignee who is not an active member).',
  )
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`VERSION_CONFLICT` (changed by someone else) or `RECORD_ALREADY_CLOSED` (it is DONE or CANCELLED).',
  )
  update(
    @Param('reminderId', ParseUUIDPipe) reminderId: string,
    @Body() dto: UpdateReminderDto,
  ): Promise<ReminderDto> {
    return this.reminders.update(reminderId, dto);
  }

  /**
   * Settle a reminder. Only the two steps the transition table lists exist (PENDING to DONE, PENDING to
   * CANCELLED with a reason), and only the assignee or a reminder manager may take one — which is why this
   * handler declares the loosest thing the catalogue can say and the service decides from the row.
   */
  @Post(':reminderId/status')
  @HttpCode(HttpStatus.OK)
  @OrganisationMember()
  @ApiOperation({ operationId: 'changeReminderStatus', summary: 'Complete or cancel a reminder' })
  @ApiOkResponse({ type: ReminderDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (the reason a cancellation needs is missing or too short).',
  )
  @ApiProblemResponse(
    HttpStatus.FORBIDDEN,
    '`NOT_ASSIGNEE`: the caller is neither the assignee nor someone who manages reminders.',
  )
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`INVALID_TRANSITION` (the reminder is settled, or the step does not exist) or `VERSION_CONFLICT`.',
  )
  changeStatus(
    @Param('reminderId', ParseUUIDPipe) reminderId: string,
    @Body() dto: ChangeReminderStatusDto,
  ): Promise<ReminderDto> {
    return this.reminders.changeStatus(reminderId, dto);
  }
}
