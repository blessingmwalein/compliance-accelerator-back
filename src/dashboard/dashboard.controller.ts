import { Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import {
  DashboardFrameworksDto,
  DashboardGapAnalysisDto,
  DashboardSummaryDto,
  DashboardTopRisksDto,
  TopRisksQueryDto,
} from './dashboard.dto.js';
import { DashboardService } from './dashboard.service.js';

/**
 * The executive dashboard (Phase 8): the organisation's position in one screen, every figure decided on the
 * server. Nothing here is a legal verdict — the payload says so in the same words as the report does.
 *
 * The sections another module already answers for (the risk summary and heat map, the RoPA monitor, the
 * priority matrix, the DSAR SLA, the breach summary) keep their own endpoints, so a number on this screen
 * and the number on that register are the same query.
 */
@ApiTags('dashboard')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(HttpStatus.NOT_FOUND, 'Not a member of this organisation.')
@Controller('organisations/:organisationId/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /**
   * The organisation-wide maturity and exposure figures and the six getting-started steps. A set of cycles
   * scored under more than one methodology says so as `unable_to_calculate` rather than averaging them.
   */
  @Get('summary')
  @RequirePermission('dashboard.view')
  @ApiOperation({
    operationId: 'getDashboardSummary',
    summary:
      'The dashboard summary: organisation-wide maturity, exposure and getting-started steps',
  })
  @ApiOkResponse({ type: DashboardSummaryDto })
  summary(): Promise<DashboardSummaryDto> {
    return this.dashboard.summary();
  }

  /**
   * Coverage and maturity per applicable framework: the same rows feed the comparison bar, the radar, the
   * table and the compliance cards, so those views cannot tell different stories.
   */
  @Get('frameworks')
  @RequirePermission('dashboard.view')
  @ApiOperation({
    operationId: 'getDashboardFrameworks',
    summary: 'Framework coverage and maturity comparison for the dashboard',
  })
  @ApiOkResponse({ type: DashboardFrameworksDto })
  frameworks(): Promise<DashboardFrameworksDto> {
    return this.dashboard.frameworks();
  }

  /** Each governance area's distance from its target, biggest gap first, with the highlight gap stated. */
  @Get('gap-analysis')
  @RequirePermission('dashboard.view')
  @ApiOperation({
    operationId: 'getDashboardGapAnalysis',
    summary: 'Gap analysis by governance area',
  })
  @ApiOkResponse({ type: DashboardGapAnalysisDto })
  gapAnalysis(): Promise<DashboardGapAnalysisDto> {
    return this.dashboard.gapAnalysis();
  }

  /** `risk.top`: the carried risks ranked by the exposure their own register rows store. */
  @Get('top-risks')
  @RequirePermission('dashboard.view')
  @ApiOperation({
    operationId: 'getDashboardTopRisks',
    summary: 'The highest-exposure carried risks',
  })
  @ApiOkResponse({ type: DashboardTopRisksDto })
  topRisks(@Query() query: TopRisksQueryDto): Promise<DashboardTopRisksDto> {
    return this.dashboard.topRisks(query);
  }

  /**
   * The AI risk assessment is Phase 10 work: the endpoint exists so the screen can show the action and its
   * reason, and the reason is true. Nothing is generated, stored or queued here yet, and no prompt is run
   * against this organisation's data.
   */
  @Post('ai-assessment')
  @HttpCode(HttpStatus.SERVICE_UNAVAILABLE)
  @RequirePermission('ai.run')
  @ApiOperation({
    operationId: 'runDashboardAiAssessment',
    summary: 'Ask for an AI risk assessment (not available in this build)',
  })
  @ApiProblemResponse(
    HttpStatus.SERVICE_UNAVAILABLE,
    'AI assessment is not built yet (Phase 10): nothing was generated and no data left the organisation.',
  )
  aiAssessment(): Promise<never> {
    throw new AppException(
      ErrorCode.FeatureUnavailable,
      HttpStatus.SERVICE_UNAVAILABLE,
      'AI risk assessment is not available in this build yet.',
    );
  }
}
