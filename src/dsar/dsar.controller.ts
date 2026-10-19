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
  ApiBody,
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
  AddDsarCommunicationDto,
  ChangeDsarStatusDto,
  CreateDsarRequestDto,
  DsarRequestDetailDto,
  DsarRequestDto,
  DsarRequestPageDto,
  DsarSlaDto,
  ExtendDsarRequestDto,
  LinkDsarEvidenceDto,
  ListDsarQueryDto,
  UpdateDsarRequestDto,
  VerifyDsarIdentityDto,
} from './dsar.dto.js';
import { DsarService } from './dsar.service.js';

/**
 * The data subject request tracker (AC-DSAR-01, AC-DSAR-02, AC-DSAR-03).
 *
 * Reading and writing a request takes the data permissions. The status endpoint declares
 * `@OrganisationMember()` because its rule is per-row and per-step — some steps end the request and belong
 * to an approver, the rest belong to whoever works the case — and only the service, which has the row, can
 * decide. Granting an extension is a decision about a legal window, so it takes `governance.edit`. Nothing
 * here deletes a request: the lifecycle ends at COMPLETED, REFUSED or WITHDRAWN, and the communication log
 * and the extension ledger only ever grow.
 *
 * `sla` is declared before `:requestId` so its word is never read as an id.
 */
@ApiTags('dsar')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or the request does not exist.',
)
@Controller('organisations/:organisationId/dsar')
export class DsarController {
  constructor(private readonly dsar: DsarService) {}

  /**
   * Answered on time, late, still open past its deadline: the buckets counted over the requests received in
   * the last twelve months and measured against today. `state` says why a side of it is empty — no response
   * window configured, or nothing to count — rather than reporting a percentage nobody measured.
   */
  @Get('sla')
  @RequirePermission('data.view')
  @ApiOperation({
    operationId: 'getDsarSla',
    summary: 'The SLA the data subject requests were worked to',
  })
  @ApiOkResponse({ type: DsarSlaDto })
  sla(): Promise<DsarSlaDto> {
    return this.dsar.sla();
  }

  @Get()
  @RequirePermission('data.view')
  @ApiOperation({ operationId: 'listDsarRequests', summary: 'List the data subject requests' })
  @ApiOkResponse({ type: DsarRequestPageDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (an unknown status, type or identity state, a date that is not YYYY-MM-DD).',
  )
  list(@Query() query: ListDsarQueryDto): Promise<DsarRequestPageDto> {
    return this.dsar.list(query);
  }

  /**
   * Record a request. The response window is copied from the deadline policy in force at this moment and
   * the dates it gives are frozen onto the row; a later change to the policy cannot move them.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('data.create')
  @ApiOperation({ operationId: 'createDsarRequest', summary: 'Record a data subject request' })
  @ApiBody({ type: CreateDsarRequestDto })
  @ApiCreatedResponse({ type: DsarRequestDetailDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (a request type that is not one of ours, a date in the future, an owner or business unit that is not this organisation’s).',
  )
  create(@Body() dto: CreateDsarRequestDto): Promise<DsarRequestDetailDto> {
    return this.dsar.create(dto);
  }

  /** One request with its communication log and the evidence attached to it. */
  @Get(':requestId')
  @RequirePermission('data.view')
  @ApiOperation({
    operationId: 'getDsarRequest',
    summary: 'One request, with its chronology and evidence',
  })
  @ApiOkResponse({ type: DsarRequestDetailDto })
  detail(@Param('requestId', ParseUUIDPipe) requestId: string): Promise<DsarRequestDetailDto> {
    return this.dsar.detail(requestId);
  }

  /**
   * The request's content: its type, its text and who owns it. A closed request answers 409
   * `RECORD_ALREADY_CLOSED` — its outcome is a dated decision that is never edited away.
   */
  @Patch(':requestId')
  @RequirePermission('data.edit')
  @ApiOperation({ operationId: 'updateDsarRequest', summary: 'Change a data subject request' })
  @ApiBody({ type: UpdateDsarRequestDto })
  @ApiOkResponse({ type: DsarRequestDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed.')
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`VERSION_CONFLICT`: changed by someone else, or `RECORD_ALREADY_CLOSED`.',
  )
  update(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: UpdateDsarRequestDto,
  ): Promise<DsarRequestDto> {
    return this.dsar.update(requestId, dto);
  }

  /**
   * One step along the lifecycle, as the transition table defines it. The steps that end a request belong
   * to an approver, state the outcome in words and need proof attached; a request cannot be COMPLETED
   * before the requester's identity is verified.
   */
  @Post(':requestId/status')
  @HttpCode(HttpStatus.OK)
  @OrganisationMember()
  @ApiOperation({ operationId: 'changeDsarStatus', summary: "Change a request's status" })
  @ApiBody({ type: ChangeDsarStatusDto })
  @ApiOkResponse({ type: DsarRequestDetailDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (an outcome the step requires is missing, no evidence attached, the status is already the one asked for).',
  )
  @ApiProblemResponse(
    HttpStatus.FORBIDDEN,
    'The step belongs to an approver and the caller is not one.',
  )
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`INVALID_TRANSITION` (the table lists the steps that exist), `VERSION_CONFLICT`.',
  )
  @ApiProblemResponse(
    HttpStatus.UNPROCESSABLE_ENTITY,
    '`IDENTITY_NOT_VERIFIED`: the requester’s identity has not been proven, so their data cannot be handed over.',
  )
  changeStatus(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: ChangeDsarStatusDto,
  ): Promise<DsarRequestDetailDto> {
    return this.dsar.changeStatus(requestId, dto);
  }

  /** Prove the requester is who they say they are: a named person's dated decision. */
  @Post(':requestId/identity')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('data.edit')
  @ApiOperation({ operationId: 'verifyDsarIdentity', summary: 'Verify the requester’s identity' })
  @ApiBody({ type: VerifyDsarIdentityDto })
  @ApiOkResponse({ type: DsarRequestDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (already verified, a check dated before the request arrived).',
  )
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`: changed by someone else.')
  verifyIdentity(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: VerifyDsarIdentityDto,
  ): Promise<DsarRequestDto> {
    return this.dsar.verifyIdentity(requestId, dto);
  }

  /**
   * Grant one more extension, for the days the policy allows. The new deadline is the current one plus
   * those days — never a window recomputed from today's policy — and the request's base date and policy id
   * stay as they were.
   */
  @Post(':requestId/extension')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('governance.edit')
  @ApiOperation({ operationId: 'extendDsarRequest', summary: 'Extend the deadline of a request' })
  @ApiBody({ type: ExtendDsarRequestDto })
  @ApiOkResponse({ type: DsarRequestDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed (an extension needs a reason).')
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`: changed by someone else.')
  @ApiProblemResponse(
    HttpStatus.UNPROCESSABLE_ENTITY,
    '`EXTENSION_NOT_ALLOWED`: the request is closed, has no deadline, has no extension window configured, or has used every extension the policy allows.',
  )
  extend(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: ExtendDsarRequestDto,
  ): Promise<DsarRequestDto> {
    return this.dsar.extend(requestId, dto);
  }

  /**
   * One line of the communication log: a message sent, a message received, a note. The body of the
   * correspondence is never stored here, so the log cannot become a copy of the data subject's words.
   */
  @Post(':requestId/communications')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('data.edit')
  @ApiOperation({
    operationId: 'addDsarCommunication',
    summary: 'Add a line to the communication log',
  })
  @ApiBody({ type: AddDsarCommunicationDto })
  @ApiCreatedResponse({ type: DsarRequestDetailDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed.')
  addCommunication(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: AddDsarCommunicationDto,
  ): Promise<DsarRequestDetailDto> {
    return this.dsar.addCommunication(requestId, dto);
  }

  /** Attach a file this organisation has already uploaded. Attaching it twice is refused. */
  @Post(':requestId/evidence')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('data.edit')
  @ApiOperation({ operationId: 'linkDsarEvidence', summary: 'Attach evidence to a request' })
  @ApiBody({ type: LinkDsarEvidenceDto })
  @ApiCreatedResponse({ type: DsarRequestDetailDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed.')
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`CONFLICT`: this file is already attached to the request.',
  )
  linkEvidence(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: LinkDsarEvidenceDto,
  ): Promise<DsarRequestDetailDto> {
    return this.dsar.linkEvidence(requestId, dto);
  }

  /** Detach a file from the request. The file itself stays in the evidence repository. */
  @Delete(':requestId/evidence/:evidenceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('data.edit')
  @ApiOperation({
    operationId: 'unlinkDsarEvidence',
    summary: 'Detach evidence from a request (the file itself stays)',
  })
  @ApiNoContentResponse({ description: 'The link was removed.' })
  @ApiProblemResponse(HttpStatus.NOT_FOUND, 'No such request, or this file was not attached to it.')
  unlinkEvidence(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
  ): Promise<void> {
    return this.dsar.unlinkEvidence(requestId, evidenceId);
  }
}
