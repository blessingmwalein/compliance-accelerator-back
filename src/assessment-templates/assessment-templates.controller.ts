import { Controller, Get, HttpStatus, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import { AssessmentTemplateDetailDto, AssessmentTemplateDto } from './assessment-templates.dto.js';
import { AssessmentTemplatesService } from './assessment-templates.service.js';

/**
 * The published quick-start templates. Read-only reference data: applying one happens on an assessment,
 * and a shipped template is never edited, only re-published as a new edition.
 */
@ApiTags('assessment-templates')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or the template does not exist.',
)
@Controller('organisations/:organisationId')
export class AssessmentTemplatesController {
  constructor(private readonly templates: AssessmentTemplatesService) {}

  /** The newest edition of each template, with how many subjects it holds. */
  @Get('assessment-templates')
  @RequirePermission('governance.view')
  @ApiOperation({
    operationId: 'listAssessmentTemplates',
    summary: 'List the quick-start templates',
  })
  @ApiOkResponse({ type: [AssessmentTemplateDto] })
  list(): Promise<AssessmentTemplateDto[]> {
    return this.templates.list();
  }

  @Get('assessment-templates/:templateId')
  @RequirePermission('governance.view')
  @ApiOperation({
    operationId: 'getAssessmentTemplate',
    summary: 'One template with its subjects',
  })
  @ApiParam({ name: 'templateId', type: String, format: 'uuid' })
  @ApiOkResponse({ type: AssessmentTemplateDetailDto })
  get(
    @Param('templateId', ParseUUIDPipe) templateId: string,
  ): Promise<AssessmentTemplateDetailDto> {
    return this.templates.get(templateId);
  }
}
