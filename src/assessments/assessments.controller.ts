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
import { RequirePermission } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import { AssessmentsService } from './assessments.service.js';
import {
  ApproveAssessmentDto,
  AssessmentDto,
  AssessmentHistoryDto,
  AssessmentListQueryDto,
  AssessmentPageDto,
  AssessmentSummaryDto,
  AssessmentVersionDto,
  AssessmentVersionQueryDto,
  CreateAssessmentDto,
  ItemFilterQueryDto,
  ReturnAssessmentDto,
  SubmitAssessmentDto,
  UpdateAssessmentDto,
} from './assessments.dto.js';

/**
 * Assessment cycles (AC-GOV-02, AC-GOV-03, AC-GOV-04). A cycle is a DRAFT while it is being worked on, is
 * submitted for review, and stops changing when it is approved; the next round of work is a NEW cycle that
 * revises it, and the old one is kept readable forever.
 */
@ApiTags('assessments')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or no such assessment.',
)
@Controller('organisations/:organisationId/assessments')
export class AssessmentsController {
  constructor(private readonly assessments: AssessmentsService) {}

  @Get()
  @RequirePermission('governance.view')
  @ApiOperation({ operationId: 'listAssessments', summary: 'List the assessment cycles' })
  @ApiOkResponse({ type: AssessmentPageDto })
  list(@Query() query: AssessmentListQueryDto): Promise<AssessmentPageDto> {
    return this.assessments.list(query);
  }

  /** Opens a cycle: a DRAFT carrying the exposure bands currently in force. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('governance.create')
  @ApiOperation({ operationId: 'createAssessment', summary: 'Start an assessment cycle' })
  @ApiCreatedResponse({ type: AssessmentDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    '`VALIDATION_FAILED`, including an unusable `revisesAssessmentId`.',
  )
  create(@Body() dto: CreateAssessmentDto): Promise<AssessmentDto> {
    return this.assessments.create(dto);
  }

  @Get(':assessmentId')
  @RequirePermission('governance.view')
  @ApiOperation({ operationId: 'getAssessment', summary: 'Read one assessment cycle' })
  @ApiOkResponse({ type: AssessmentDto })
  get(@Param('assessmentId', ParseUUIDPipe) assessmentId: string): Promise<AssessmentDto> {
    return this.assessments.get(assessmentId);
  }

  @Patch(':assessmentId')
  @RequirePermission('governance.edit')
  @ApiOperation({ operationId: 'updateAssessment', summary: 'Change a draft assessment' })
  @ApiOkResponse({ type: AssessmentDto })
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`, or `ASSESSMENT_NOT_EDITABLE`.')
  update(
    @Param('assessmentId', ParseUUIDPipe) assessmentId: string,
    @Body() dto: UpdateAssessmentDto,
  ): Promise<AssessmentDto> {
    return this.assessments.update(assessmentId, dto);
  }

  /** Throws away a DRAFT cycle with its items. A cycle that tasks were raised from cannot be deleted. */
  @Delete(':assessmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('governance.delete')
  @ApiOperation({ operationId: 'deleteAssessment', summary: 'Delete a draft assessment' })
  @ApiNoContentResponse({ description: 'The draft was deleted.' })
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`VERSION_CONFLICT`, `ASSESSMENT_NOT_EDITABLE`, or tasks refer to it.',
  )
  remove(
    @Param('assessmentId', ParseUUIDPipe) assessmentId: string,
    @Query() query: AssessmentVersionQueryDto,
  ): Promise<void> {
    return this.assessments.remove(assessmentId, query.version);
  }

  @Post(':assessmentId/submit')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('governance.edit')
  @ApiOperation({ operationId: 'submitAssessment', summary: 'Send the draft for review' })
  @ApiOkResponse({ type: AssessmentDto })
  @ApiProblemResponse(HttpStatus.UNPROCESSABLE_ENTITY, '`ASSESSMENT_EMPTY`: nothing to review yet.')
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`, or it is not a draft.')
  submit(
    @Param('assessmentId', ParseUUIDPipe) assessmentId: string,
    @Body() dto: SubmitAssessmentDto,
  ): Promise<AssessmentDto> {
    return this.assessments.submit(assessmentId, dto);
  }

  /** The sign-off. Whoever approves it is named in the record and in the audit trail (AC-GOV-04). */
  @Post(':assessmentId/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('governance.approve')
  @ApiOperation({ operationId: 'approveAssessment', summary: 'Approve an assessment' })
  @ApiOkResponse({ type: AssessmentDto })
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`, or it was never submitted.')
  approve(
    @Param('assessmentId', ParseUUIDPipe) assessmentId: string,
    @Body() dto: ApproveAssessmentDto,
  ): Promise<AssessmentDto> {
    return this.assessments.approve(assessmentId, dto);
  }

  @Post(':assessmentId/return')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('governance.approve')
  @ApiOperation({ operationId: 'returnAssessment', summary: 'Return an assessment for more work' })
  @ApiOkResponse({ type: AssessmentDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, '`VALIDATION_FAILED`: a return always says why.')
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`, or it was never submitted.')
  returnForReview(
    @Param('assessmentId', ParseUUIDPipe) assessmentId: string,
    @Body() dto: ReturnAssessmentDto,
  ): Promise<AssessmentDto> {
    return this.assessments.returnForReview(assessmentId, dto);
  }

  /** Opens the next cycle over an approved one, with the same items and ratings to work from. */
  @Post(':assessmentId/revise')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('governance.create')
  @ApiOperation({
    operationId: 'reviseAssessment',
    summary: 'Start a revision of an approved cycle',
  })
  @ApiCreatedResponse({ type: AssessmentDto })
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`, or it is still being worked on.')
  revise(
    @Param('assessmentId', ParseUUIDPipe) assessmentId: string,
    @Body() dto: AssessmentVersionDto,
  ): Promise<AssessmentDto> {
    return this.assessments.revise(assessmentId, dto);
  }

  @Get(':assessmentId/history')
  @RequirePermission('governance.view')
  @ApiOperation({
    operationId: 'getAssessmentHistory',
    summary: 'Every cycle of this assessment line, oldest first',
  })
  @ApiOkResponse({ type: AssessmentHistoryDto })
  history(
    @Param('assessmentId', ParseUUIDPipe) assessmentId: string,
  ): Promise<AssessmentHistoryDto> {
    return this.assessments.history(assessmentId);
  }

  @Get(':assessmentId/summary')
  @RequirePermission('governance.view')
  @ApiOperation({ operationId: 'getAssessmentSummary', summary: 'The roll-up of an assessment' })
  @ApiOkResponse({ type: AssessmentSummaryDto })
  summary(
    @Param('assessmentId', ParseUUIDPipe) assessmentId: string,
    @Query() filters: ItemFilterQueryDto,
  ): Promise<AssessmentSummaryDto> {
    return this.assessments.summary(assessmentId, filters);
  }
}
