import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RequirePermission } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import { contentDisposition } from '../common/http/content-disposition.js';
import { GenerateGovernanceAssessmentDto, ReportDto } from './reports.dto.js';
import { ReportsService } from './reports.service.js';

/**
 * Documents rendered on the server from the caller's own, organisation-scoped data and stored as records
 * (ADR-0008). The PDF is never a public URL: it is streamed back through the download route below.
 */
@ApiTags('reports')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or the report or assessment does not exist.',
)
@Controller('organisations/:organisationId/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /**
   * Renders the Governance Assessment of one cycle (optionally narrowed to a business unit and a framework)
   * and stores it. Synchronous by design: a single assessment cycle is a small export, which the report rules
   * allow to be generated in the request as long as the record is created.
   */
  @Post('governance-assessment')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('reports.export')
  @ApiOperation({
    operationId: 'generateGovernanceAssessment',
    summary: 'Render and store the Governance Assessment PDF of an assessment',
  })
  @ApiBody({ type: GenerateGovernanceAssessmentDto })
  @ApiCreatedResponse({ type: ReportDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed: the assessment id is missing or not a uuid.',
  )
  generate(@Body() dto: GenerateGovernanceAssessmentDto): Promise<ReportDto> {
    return this.reports.generate(dto);
  }

  /**
   * Renders and stores the Executive Dashboard (Phase 8): the organisation-wide figures, the framework
   * comparison, the gap list and the highest-exposure risks. There is nothing to send: the document covers the
   * whole organisation, as of the day it is drawn, from the same payloads the dashboard screen reads.
   */
  @Post('executive-dashboard')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('reports.export')
  @ApiOperation({
    operationId: 'generateExecutiveDashboard',
    summary: 'Render and store the Executive Dashboard PDF',
  })
  @ApiCreatedResponse({ type: ReportDto })
  generateExecutiveDashboard(): Promise<ReportDto> {
    return this.reports.generateExecutiveDashboard();
  }

  /** One stored report: its parameters, status, size and checksum. The bytes come from the download route. */
  @Get(':reportId')
  @RequirePermission('reports.view')
  @ApiOperation({ operationId: 'getReport', summary: 'Read one stored report' })
  @ApiOkResponse({ type: ReportDto })
  get(@Param('reportId', ParseUUIDPipe) reportId: string): Promise<ReportDto> {
    return this.reports.get(reportId);
  }

  /**
   * The PDF, streamed to someone who may read reports. The `ETag` is the stored checksum, so re-checking an
   * unchanged file costs a 304 rather than a download; every download is audited.
   */
  @Get(':reportId/download')
  @RequirePermission('reports.view')
  @ApiOperation({
    operationId: 'downloadReport',
    summary: 'Download a stored report (proxied, with attachment disposition)',
  })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ description: 'The PDF bytes.', schema: { type: 'string', format: 'binary' } })
  @ApiProblemResponse(
    HttpStatus.NOT_FOUND,
    'No such report in this organisation, or its stored file is missing.',
  )
  async download(
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.reports.download(reportId);
    const etag = `"${file.sha256}"`;
    response.setHeader('ETag', etag);
    // private: it is served to authorised members only; the browser revalidates instead of trusting a stale copy
    response.setHeader('Cache-Control', 'private, no-cache');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'");
    response.setHeader('Content-Disposition', contentDisposition(file.filename, 'report.pdf'));
    if (request.headers['if-none-match'] === etag) {
      response.status(HttpStatus.NOT_MODIFIED).end();
      return;
    }
    response.setHeader('Content-Type', file.contentType);
    response.setHeader('Content-Length', String(file.data.length));
    response.status(HttpStatus.OK).end(file.data);
  }
}
