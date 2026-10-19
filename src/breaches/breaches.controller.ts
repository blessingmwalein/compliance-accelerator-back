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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { OrganisationMember, RequirePermission } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import {
  AddBreachChronologyDto,
  BreachDetailDto,
  BreachDto,
  BreachPageDto,
  BreachSummaryDto,
  ChangeBreachStatusDto,
  CreateBreachDto,
  LinkBreachEvidenceDto,
  ListBreachesQueryDto,
  RecordBreachDecisionDto,
  UpdateBreachDto,
} from './breaches.dto.js';
import { BreachesService } from './breaches.service.js';

/**
 * The personal data breach registry: the breaches themselves, their status lifecycle, their append-only
 * timeline and notification ledger, and the evidence attached to them.
 *
 * Reading and writing the registry takes the governance permissions. The status endpoint declares
 * `@OrganisationMember()` because its rule is per-row and per-step — the steps between the working phases
 * belong to an editor, closing belongs to an approver — and the service, which has the row, decides. A
 * notification decision is an approver's call, because it is the decision whether an authority is told.
 * Nothing here deletes a breach: the lifecycle ends at CLOSED and the ledger only ever grows.
 */
@ApiTags('breaches')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or the breach does not exist.',
)
@Controller('organisations/:organisationId/breaches')
export class BreachesController {
  constructor(private readonly breaches: BreachesService) {}

  /** `summary` is declared before `:breachId` so its word is never read as an id. */
  @Get('summary')
  @RequirePermission('governance.view')
  @ApiOperation({
    operationId: 'getBreachSummary',
    summary: 'The registry counted: open, detected this year, with a late undecided duty',
  })
  @ApiOkResponse({ type: BreachSummaryDto })
  summary(): Promise<BreachSummaryDto> {
    return this.breaches.summary();
  }

  @Get()
  @RequirePermission('governance.view')
  @ApiOperation({ operationId: 'listBreaches', summary: 'List the breach registry' })
  @ApiOkResponse({ type: BreachPageDto })
  list(@Query() query: ListBreachesQueryDto): Promise<BreachPageDto> {
    return this.breaches.list(query);
  }

  /**
   * Record a breach. The two deadlines are the ones the policy in force gives the detection day, frozen
   * onto the row; the notification duty starts undecided and the designated contact is told.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('governance.create')
  @ApiOperation({ operationId: 'createBreach', summary: 'Add a breach to the registry' })
  @ApiCreatedResponse({ type: BreachDetailDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (an unknown business unit or owner, a detection day that is not a calendar date).',
  )
  create(@Body() dto: CreateBreachDto): Promise<BreachDetailDto> {
    return this.breaches.create(dto);
  }

  @Get(':breachId')
  @RequirePermission('governance.view')
  @ApiOperation({
    operationId: 'getBreach',
    summary: 'One breach, with its timeline, its decisions and its evidence',
  })
  @ApiOkResponse({ type: BreachDetailDto })
  detail(@Param('breachId', ParseUUIDPipe) breachId: string): Promise<BreachDetailDto> {
    return this.breaches.detail(breachId);
  }

  /**
   * The registry's content: text, the people and unit it belongs to. The status has its own endpoint and so
   * do the timeline, the decision and the evidence, because each is a decision with its own rules.
   */
  @Patch(':breachId')
  @RequirePermission('governance.edit')
  @ApiOperation({ operationId: 'updateBreach', summary: 'Change a breach' })
  @ApiOkResponse({ type: BreachDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed.')
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`VERSION_CONFLICT`: changed by someone else, or `RECORD_ALREADY_CLOSED`: a closed breach does not change.',
  )
  update(
    @Param('breachId', ParseUUIDPipe) breachId: string,
    @Body() dto: UpdateBreachDto,
  ): Promise<BreachDto> {
    return this.breaches.update(breachId, dto);
  }

  /**
   * One step along the lifecycle, as the transition table defines it. Closing needs `governance.approve`,
   * the outcome in words, and a notification decision already on the ledger.
   */
  @Post(':breachId/status')
  @HttpCode(HttpStatus.OK)
  @OrganisationMember()
  @ApiOperation({ operationId: 'changeBreachStatus', summary: "Change a breach's status" })
  @ApiOkResponse({ type: BreachDetailDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (a reason the step requires is missing, or the status is already the one asked for).',
  )
  @ApiProblemResponse(
    HttpStatus.FORBIDDEN,
    'The step belongs to an approver and the caller is not one.',
  )
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`INVALID_TRANSITION` (the table lists the steps that exist, and CLOSED is the end of the line) or `VERSION_CONFLICT`.',
  )
  @ApiProblemResponse(
    HttpStatus.UNPROCESSABLE_ENTITY,
    '`BREACH_DECISION_REQUIRED`: the breach has no notification decision on its ledger yet.',
  )
  changeStatus(
    @Param('breachId', ParseUUIDPipe) breachId: string,
    @Body() dto: ChangeBreachStatusDto,
  ): Promise<BreachDetailDto> {
    return this.breaches.changeStatus(breachId, dto);
  }

  /** One event added to the timeline: a step, written in the order it happened. */
  @Post(':breachId/chronology')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('governance.edit')
  @ApiOperation({ operationId: 'addBreachChronology', summary: 'Add a step to a breach timeline' })
  @ApiCreatedResponse({ type: BreachDetailDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed.')
  addChronology(
    @Param('breachId', ParseUUIDPipe) breachId: string,
    @Body() dto: AddBreachChronologyDto,
  ): Promise<BreachDetailDto> {
    return this.breaches.addChronology(breachId, dto);
  }

  /**
   * Record the notification decision. The ledger is append-only: a second decision adds a row and the first
   * stays, so what was known on a given date keeps its answer.
   */
  @Post(':breachId/decision')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('governance.approve')
  @ApiOperation({
    operationId: 'recordBreachNotificationDecision',
    summary: 'Record a breach notification decision',
  })
  @ApiCreatedResponse({ type: BreachDetailDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (a decision to notify with no date or no authority, a decision not to notify that names one, an unknown regulator contact).',
  )
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`VERSION_CONFLICT`, or `RECORD_ALREADY_CLOSED`: nothing is decided about a breach that is closed.',
  )
  recordDecision(
    @Param('breachId', ParseUUIDPipe) breachId: string,
    @Body() dto: RecordBreachDecisionDto,
  ): Promise<BreachDetailDto> {
    return this.breaches.recordDecision(breachId, dto);
  }

  /** Attach an evidence file this organisation has already uploaded. */
  @Post(':breachId/evidence')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('governance.edit')
  @ApiOperation({ operationId: 'linkBreachEvidence', summary: 'Attach evidence to a breach' })
  @ApiCreatedResponse({ type: BreachDetailDto })
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`CONFLICT`: the same file is already attached to this breach.',
  )
  linkEvidence(
    @Param('breachId', ParseUUIDPipe) breachId: string,
    @Body() dto: LinkBreachEvidenceDto,
  ): Promise<BreachDetailDto> {
    return this.breaches.linkEvidence(breachId, dto.evidenceId);
  }

  /** Detach the link. The file itself stays in the evidence repository. */
  @Delete(':breachId/evidence/:evidenceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('governance.edit')
  @ApiOperation({
    operationId: 'unlinkBreachEvidence',
    summary: 'Detach evidence from a breach (the file itself stays)',
  })
  @ApiNoContentResponse({ description: 'The link was removed.' })
  @ApiProblemResponse(HttpStatus.NOT_FOUND, '`NOT_FOUND`: this breach has no such attachment.')
  unlinkEvidence(
    @Param('breachId', ParseUUIDPipe) breachId: string,
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
  ): Promise<void> {
    return this.breaches.unlinkEvidence(breachId, evidenceId);
  }
}
