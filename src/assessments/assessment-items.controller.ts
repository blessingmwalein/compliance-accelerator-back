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
import { AssessmentItemsService } from './assessment-items.service.js';
import {
  ApplyTemplateDto,
  ApplyTemplateResultDto,
  AssessmentItemDto,
  AssessmentItemListQueryDto,
  AssessmentItemPageDto,
  CreateAssessmentItemDto,
  ItemEvidenceDto,
  LinkEvidenceDto,
  UpdateAssessmentItemDto,
} from './assessments.dto.js';

/**
 * The items of an assessment: one rated subject (a governance area, a framework requirement, or both, for one
 * business unit or the whole organisation). `gap`, `exposure` and `riskLevel` are derived on the server from
 * the ratings and the cycle's own band snapshot, so a client can never put a number in their place.
 */
@ApiTags('assessment-items')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or no such assessment or item.',
)
@Controller('organisations/:organisationId')
export class AssessmentItemsController {
  constructor(private readonly items: AssessmentItemsService) {}

  @Get('assessments/:assessmentId/items')
  @RequirePermission('governance.view')
  @ApiOperation({ operationId: 'listAssessmentItems', summary: 'List the items of an assessment' })
  @ApiOkResponse({ type: AssessmentItemPageDto })
  list(
    @Param('assessmentId', ParseUUIDPipe) assessmentId: string,
    @Query() query: AssessmentItemListQueryDto,
  ): Promise<AssessmentItemPageDto> {
    return this.items.list(assessmentId, query);
  }

  @Post('assessments/:assessmentId/items')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('governance.create')
  @ApiOperation({
    operationId: 'createAssessmentItem',
    summary: 'Add an item to a draft assessment',
  })
  @ApiCreatedResponse({ type: AssessmentItemDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    '`VALIDATION_FAILED`: an unknown area, unit or requirement.',
  )
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`ASSESSMENT_ITEM_EXISTS`, or the assessment is not a draft.',
  )
  create(
    @Param('assessmentId', ParseUUIDPipe) assessmentId: string,
    @Body() dto: CreateAssessmentItemDto,
  ): Promise<AssessmentItemDto> {
    return this.items.create(assessmentId, dto);
  }

  /** Fills a draft with the template's subjects, every one of them still unassessed (AC-GOV-01). */
  @Post('assessments/:assessmentId/items/from-template')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('governance.create')
  @ApiOperation({
    operationId: 'applyAssessmentTemplate',
    summary: 'Add a quick-start template’s subjects to a draft assessment',
  })
  @ApiCreatedResponse({ type: ApplyTemplateResultDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    '`VALIDATION_FAILED`: no published template with that id.',
  )
  @ApiProblemResponse(HttpStatus.CONFLICT, 'The assessment is not a draft.')
  applyTemplate(
    @Param('assessmentId', ParseUUIDPipe) assessmentId: string,
    @Body() dto: ApplyTemplateDto,
  ): Promise<ApplyTemplateResultDto> {
    return this.items.applyTemplate(assessmentId, dto.templateId);
  }

  @Get('assessment-items/:itemId')
  @RequirePermission('governance.view')
  @ApiOperation({ operationId: 'getAssessmentItem', summary: 'Read one item' })
  @ApiOkResponse({ type: AssessmentItemDto })
  get(@Param('itemId', ParseUUIDPipe) itemId: string): Promise<AssessmentItemDto> {
    return this.items.get(itemId);
  }

  @Patch('assessment-items/:itemId')
  @RequirePermission('governance.edit')
  @ApiOperation({
    operationId: 'updateAssessmentItem',
    summary: 'Change an item of a draft assessment',
  })
  @ApiOkResponse({ type: AssessmentItemDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, '`VALIDATION_FAILED`.')
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`VERSION_CONFLICT`, `ASSESSMENT_ITEM_EXISTS`, or not a draft.',
  )
  update(
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateAssessmentItemDto,
  ): Promise<AssessmentItemDto> {
    return this.items.update(itemId, dto);
  }

  @Delete('assessment-items/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('governance.delete')
  @ApiOperation({
    operationId: 'deleteAssessmentItem',
    summary: 'Delete an item of a draft assessment',
  })
  @ApiNoContentResponse({ description: 'The item was deleted with its evidence links.' })
  @ApiProblemResponse(HttpStatus.CONFLICT, 'The assessment is not a draft.')
  remove(@Param('itemId', ParseUUIDPipe) itemId: string): Promise<void> {
    return this.items.remove(itemId);
  }

  /** Attaches an evidence file this organisation has uploaded. Linking the same file twice changes nothing. */
  @Post('assessment-items/:itemId/evidence')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('governance.edit')
  @ApiOperation({
    operationId: 'linkAssessmentItemEvidence',
    summary: 'Attach evidence to an item',
  })
  @ApiOkResponse({ type: ItemEvidenceDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, '`VALIDATION_FAILED`: the file is not one of ours.')
  @ApiProblemResponse(HttpStatus.CONFLICT, 'The assessment is not a draft.')
  link(
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: LinkEvidenceDto,
  ): Promise<ItemEvidenceDto> {
    return this.items.linkEvidence(itemId, dto.evidenceId);
  }

  @Delete('assessment-items/:itemId/evidence/:evidenceId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('governance.edit')
  @ApiOperation({
    operationId: 'unlinkAssessmentItemEvidence',
    summary: 'Detach evidence from an item (the file itself stays)',
  })
  @ApiOkResponse({ type: ItemEvidenceDto })
  unlink(
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
  ): Promise<ItemEvidenceDto> {
    return this.items.unlinkEvidence(itemId, evidenceId);
  }
}
