import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RequirePermission } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import { contentDisposition } from '../common/http/content-disposition.js';
import { REPORT_PERMISSIONS } from './definitions/registry.js';
import {
  GenerateConsolidatedDpoDto,
  GenerateGovernanceAssessmentDto,
  ListReportsQueryDto,
  ReportCatalogueDto,
  ReportDto,
  ReportPageDto,
} from './reports.dto.js';
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
  @RequirePermission(REPORT_PERMISSIONS.export)
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
  @RequirePermission(REPORT_PERMISSIONS.export)
  @ApiOperation({
    operationId: 'generateExecutiveDashboard',
    summary: 'Render and store the Executive Dashboard PDF',
  })
  @ApiCreatedResponse({ type: ReportDto })
  generateExecutiveDashboard(): Promise<ReportDto> {
    return this.reports.generateExecutiveDashboard();
  }

  /**
   * Renders and stores the Record of Processing Activities (article 30): the standing register as it reads on the
   * day it is drawn, with the lawful basis and classification of every live activity. There is nothing to send —
   * the document covers the whole register, from the same service the RoPA screen reads.
   */
  @Post('ropa-register')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(REPORT_PERMISSIONS.export)
  @ApiOperation({
    operationId: 'generateRopaRegister',
    summary: 'Render and store the Record of Processing Activities PDF',
  })
  @ApiCreatedResponse({ type: ReportDto })
  generateRopaRegister(): Promise<ReportDto> {
    return this.reports.generateRopaRegister();
  }

  /**
   * Asks for the Consolidated DPO Report: the record is written and the job queued, and the answer is the
   * PENDING row (202, no body of its own beyond the record). The document is drawn by the job runner, which is
   * what makes a period over seven registers possible at all; `GET …/reports/{id}` is the poll, and the bytes
   * appear on the download route once the row is READY.
   */
  @Post('consolidated-dpo')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission(REPORT_PERMISSIONS.export)
  @ApiOperation({
    operationId: 'requestConsolidatedDpo',
    summary: 'Queue the Consolidated DPO Report and return its PENDING record',
  })
  @ApiBody({ type: GenerateConsolidatedDpoDto })
  @ApiResponse({
    status: HttpStatus.ACCEPTED,
    type: ReportDto,
    description: 'The queued report. Its `status` is PENDING until a job has drawn it.',
  })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed: the period is not one the catalogue lists.',
  )
  requestConsolidatedDpo(@Body() dto: GenerateConsolidatedDpoDto): Promise<ReportDto> {
    return this.reports.requestConsolidatedDpo(dto);
  }

  /**
   * The catalogue: what this build can render, each template with its version, its parameters and the
   * permission that generates it, plus the templates a later phase writes. Static reference data, so no row is
   * read and nothing is tenant-scoped about it.
   */
  @Get('catalogue')
  @RequirePermission(REPORT_PERMISSIONS.view)
  @ApiOperation({
    operationId: 'getReportCatalogue',
    summary: 'List the report templates this build can render',
  })
  @ApiOkResponse({ type: ReportCatalogueDto })
  catalogue(): ReportCatalogueDto {
    return this.reports.catalogue();
  }

  /**
   * The history: every report this organisation asked for, newest first, with the filters a reader actually
   * has — a template, a state, one assessment cycle, a window of days. A PENDING or FAILED row is listed here
   * like any other: the list is where a client sees that a document did not arrive.
   */
  @Get()
  @RequirePermission(REPORT_PERMISSIONS.view)
  @ApiOperation({ operationId: 'listReports', summary: 'List past reports with their state' })
  @ApiOkResponse({ type: ReportPageDto })
  @ApiQuery({ name: 'template', type: String, required: false, description: 'One template id.' })
  @ApiQuery({
    name: 'status',
    enumName: 'ReportStatus',
    required: false,
    description: 'PENDING, READY or FAILED.',
  })
  @ApiQuery({ name: 'assessmentId', type: String, format: 'uuid', required: false })
  @ApiQuery({ name: 'from', type: String, format: 'date', required: false })
  @ApiQuery({ name: 'to', type: String, format: 'date', required: false })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed: a date is not YYYY-MM-DD, a status is not one of the three, or the cursor is not a uuid.',
  )
  list(@Query() query: ListReportsQueryDto): Promise<ReportPageDto> {
    return this.reports.list(query);
  }

  /** One stored report: its parameters, status, size and checksum. The bytes come from the download route. */
  @Get(':reportId')
  @RequirePermission(REPORT_PERMISSIONS.view)
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
  @RequirePermission(REPORT_PERMISSIONS.view)
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
