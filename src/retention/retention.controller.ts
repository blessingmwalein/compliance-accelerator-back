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
  CreateRetentionRuleDto,
  LegalHoldDto,
  LegalHoldPageDto,
  ListLegalHoldsQueryDto,
  ListRetentionDisposalsQueryDto,
  ListRetentionRulesQueryDto,
  PlaceLegalHoldDto,
  RecordRetentionDisposalDto,
  ReleaseLegalHoldDto,
  RetentionDisposalDto,
  RetentionDisposalPageDto,
  RetentionRuleDetailDto,
  RetentionRuleDto,
  RetentionRulePageDto,
  RetentionRuleVersionDto,
  UpdateRetentionRuleDto,
} from './retention.dto.js';
import { RetentionService } from './retention.service.js';

/**
 * The retention register: rules, legal holds, and the log of disposals the organisation carried out.
 *
 * Reading and writing the rules takes the ordinary data permissions. The three things that are DECISIONS
 * — placing a hold, lifting one, and stating that records were destroyed — take `governance.approve`, the
 * same key that signs off an assessment. Nothing on this API deletes a record: rules are archived, holds
 * are released, and the disposal log only ever grows.
 */
@ApiTags('retention')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or the rule, hold or disposal entry does not exist.',
)
@Controller('organisations/:organisationId/retention')
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Get('rules')
  @RequirePermission('data.view')
  @ApiOperation({ operationId: 'listRetentionRules', summary: 'List the retention rules' })
  @ApiOkResponse({ type: RetentionRulePageDto })
  listRules(@Query() query: ListRetentionRulesQueryDto): Promise<RetentionRulePageDto> {
    return this.retention.listRules(query);
  }

  @Post('rules')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('data.create')
  @ApiOperation({ operationId: 'createRetentionRule', summary: 'Write a retention rule' })
  @ApiCreatedResponse({ type: RetentionRuleDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (unknown level, grace period without a period, owner who is not an active member).',
  )
  createRule(@Body() dto: CreateRetentionRuleDto): Promise<RetentionRuleDto> {
    return this.retention.createRule(dto);
  }

  @Get('rules/:ruleId')
  @RequirePermission('data.view')
  @ApiOperation({
    operationId: 'getRetentionRule',
    summary: 'One rule, with the holds that cover it',
  })
  @ApiOkResponse({ type: RetentionRuleDetailDto })
  detail(@Param('ruleId', ParseUUIDPipe) ruleId: string): Promise<RetentionRuleDetailDto> {
    return this.retention.detail(ruleId);
  }

  @Patch('rules/:ruleId')
  @RequirePermission('data.edit')
  @ApiOperation({ operationId: 'updateRetentionRule', summary: 'Change a retention rule' })
  @ApiOkResponse({ type: RetentionRuleDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed.')
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`, or the rule is archived.')
  updateRule(
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Body() dto: UpdateRetentionRuleDto,
  ): Promise<RetentionRuleDto> {
    return this.retention.updateRule(ruleId, dto);
  }

  /** Retires the rule. Refused while a live processing activity uses it or a hold covers it. */
  @Post('rules/:ruleId/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('data.delete')
  @ApiOperation({ operationId: 'archiveRetentionRule', summary: 'Archive a retention rule' })
  @ApiOkResponse({ type: RetentionRuleDto })
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`RECORD_IN_USE` (live activities), `LEGAL_HOLD_ACTIVE`, or `VERSION_CONFLICT`.',
  )
  archiveRule(
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Body() dto: RetentionRuleVersionDto,
  ): Promise<RetentionRuleDto> {
    return this.retention.archiveRule(ruleId, dto);
  }

  @Post('rules/:ruleId/unarchive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('data.delete')
  @ApiOperation({
    operationId: 'unarchiveRetentionRule',
    summary: 'Restore an archived retention rule',
  })
  @ApiOkResponse({ type: RetentionRuleDto })
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`: changed by someone else.')
  unarchiveRule(
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Body() dto: RetentionRuleVersionDto,
  ): Promise<RetentionRuleDto> {
    return this.retention.unarchiveRule(ruleId, dto);
  }

  @Get('holds')
  @RequirePermission('data.view')
  @ApiOperation({ operationId: 'listLegalHolds', summary: 'List the legal holds' })
  @ApiOkResponse({ type: LegalHoldPageDto })
  listHolds(@Query() query: ListLegalHoldsQueryDto): Promise<LegalHoldPageDto> {
    return this.retention.listHolds(query);
  }

  /** Place a hold over a rule (blanket) or over one named record. Nothing under it can be disposed of. */
  @Post('holds')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('governance.approve')
  @ApiOperation({ operationId: 'placeLegalHold', summary: 'Place a legal hold' })
  @ApiCreatedResponse({ type: LegalHoldDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (archived or unknown rule, a record that is not one of ours, kind without an id).',
  )
  placeHold(@Body() dto: PlaceLegalHoldDto): Promise<LegalHoldDto> {
    return this.retention.placeHold(dto);
  }

  /** The only write a hold ever takes. Releasing a released hold returns it unchanged. */
  @Post('holds/:holdId/release')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('governance.approve')
  @ApiOperation({ operationId: 'releaseLegalHold', summary: 'Release a legal hold' })
  @ApiOkResponse({ type: LegalHoldDto })
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`: changed by someone else.')
  releaseHold(
    @Param('holdId', ParseUUIDPipe) holdId: string,
    @Body() dto: ReleaseLegalHoldDto,
  ): Promise<LegalHoldDto> {
    return this.retention.releaseHold(holdId, dto);
  }

  @Get('disposals')
  @RequirePermission('data.view')
  @ApiOperation({
    operationId: 'listRetentionDisposals',
    summary: 'The disposal log (append-only)',
  })
  @ApiOkResponse({ type: RetentionDisposalPageDto })
  listDisposals(@Query() query: ListRetentionDisposalsQueryDto): Promise<RetentionDisposalPageDto> {
    return this.retention.listDisposals(query);
  }

  /**
   * State that a disposal was carried out under a rule. It records the act; it does not delete anything,
   * and a live hold on the rule makes the claim false, so it is refused with 409.
   */
  @Post('disposals')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('governance.approve')
  @ApiOperation({ operationId: 'recordRetentionDisposal', summary: 'Log a completed disposal' })
  @ApiCreatedResponse({ type: RetentionDisposalDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (archived or unknown rule, a date in the future).',
  )
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`DISPOSAL_BLOCKED_BY_HOLD`: a live hold covers the rule.',
  )
  recordDisposal(@Body() dto: RecordRetentionDisposalDto): Promise<RetentionDisposalDto> {
    return this.retention.recordDisposal(dto);
  }
}
