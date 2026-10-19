import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import { AlertDeliveryPageDto, ListAlertDeliveriesQueryDto } from './alerts.dto.js';
import { AlertsService } from './alerts.service.js';

/**
 * The alert ledger. Reading it is a governance-view action: who was told about a deadline, and what stopped
 * an alert from going out, is part of the evidence a compliance programme keeps. There is nothing to write
 * here — alerts are queued by the record they concern, and a row's outcome is written only by the job that
 * ran, which is why a re-run leaves a trace instead of a second message.
 */
@ApiTags('alerts')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(HttpStatus.NOT_FOUND, 'Not a member of this organisation.')
@Controller('organisations/:organisationId/alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get('deliveries')
  @RequirePermission('governance.view')
  @ApiOperation({
    operationId: 'listAlertDeliveries',
    summary: 'The alert ledger: what was raised, where it went, and what stopped it',
  })
  @ApiOkResponse({ type: AlertDeliveryPageDto })
  list(@Query() query: ListAlertDeliveriesQueryDto): Promise<AlertDeliveryPageDto> {
    return this.alerts.list(query);
  }
}
