import { Controller, Get, HttpStatus, Query, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RequirePermission } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import { contentDisposition } from '../common/http/content-disposition.js';
import type { AuditCsvFile } from './audit-trail.service.js';
import { AuditTrailService } from './audit-trail.service.js';
import { AuditEventPageDto, ListAuditQueryDto } from './audit.dto.js';

/**
 * The Audit Trail: the organisation's own append-only ledger, searched and exported.
 *
 * There is no write route and no single-event route with a body: the trail is written by the services that
 * make the changes, and the database refuses an UPDATE or a DELETE on it, so the only two things anyone can
 * do here are look and take a copy. Reading and taking a copy are separate permissions because a CSV leaves
 * the product (docs/rbac-matrix.md).
 */
@ApiTags('audit')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(HttpStatus.NOT_FOUND, 'Not a member of this organisation.')
@Controller('organisations/:organisationId/audit')
export class AuditController {
  constructor(private readonly trail: AuditTrailService) {}

  /**
   * `export` is declared before the search only for reading order — nothing here is a `:id` route, so no
   * word can be mistaken for one.
   */
  @Get('export')
  @RequirePermission('audit.export')
  @ApiOperation({
    operationId: 'exportAuditEvents',
    summary: 'Download the filtered trail as CSV (the export itself is recorded in the trail)',
    description:
      'One file carries at most 5,000 events; a period that holds more is refused with ' +
      'EXPORT_RANGE_TOO_LARGE so the caller narrows the range instead of receiving a silent half. ' +
      'The `changes` column is JSON and is cut at 1,000 characters per row, marked "[truncated]" — ' +
      'the list endpoint returns the full values.',
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'The CSV file.', schema: { type: 'string', format: 'binary' } })
  @ApiProblemResponse(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'More events fall in this period than one export can carry.',
  )
  async export(@Query() query: ListAuditQueryDto, @Res() response: Response): Promise<void> {
    const file: AuditCsvFile = await this.trail.export(query);
    // The byte-order mark is in the text: Excel reads a UTF-8 CSV as Windows-1252 without it.
    const body = Buffer.from(file.csv, 'utf8');
    // no-store: the next event can change what this file should have held, so a cached copy is a wrong copy
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Disposition', contentDisposition(file.filename, 'audit-trail.csv'));
    response.setHeader('Content-Length', String(body.length));
    response.status(HttpStatus.OK).end(body);
  }

  @Get()
  @RequirePermission('audit.view')
  @ApiOperation({
    operationId: 'listAuditEvents',
    summary: 'Search the trail by period, actor, action or record (newest first)',
  })
  @ApiOkResponse({ type: AuditEventPageDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'A filter is not a valid date, id or known action.')
  list(@Query() query: ListAuditQueryDto): Promise<AuditEventPageDto> {
    return this.trail.list(query);
  }
}
