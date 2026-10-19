import { Body, Controller, Get, HttpStatus, Patch } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import { DeadlinePolicyDto, UpdateDeadlinePolicyDto } from './deadline-policy.dto.js';
import { DeadlinePolicyService } from './deadline-policy.service.js';

/**
 * The organisation's deadline policy: the windows a data subject request and a breach are measured against,
 * and how early an alert warns. Nothing is shipped as a statutory number — an unset window leaves the
 * records that would have used it reporting `not_configured` (AC-DSAR-03, AC-BRC-01).
 */
@ApiTags('deadline-policy')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or it does not exist.',
)
@Controller('organisations/:organisationId/deadline-policy')
export class DeadlinePolicyController {
  constructor(private readonly policies: DeadlinePolicyService) {}

  /** The six windows, whether any is configured, and the version to send back with a change. */
  @Get()
  @RequirePermission('governance.view')
  @ApiOperation({ operationId: 'getDeadlinePolicy', summary: 'The deadline policy' })
  @ApiOkResponse({ type: DeadlinePolicyDto })
  get(): Promise<DeadlinePolicyDto> {
    return this.policies.get();
  }

  /** Omit a field to keep it; send `null` to unset it. The row is created by the first change. */
  @Patch()
  @RequirePermission('governance.edit')
  @ApiOperation({ operationId: 'updateDeadlinePolicy', summary: 'Change the deadline policy' })
  @ApiOkResponse({ type: DeadlinePolicyDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed.')
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`: changed by someone else.')
  update(@Body() dto: UpdateDeadlinePolicyDto): Promise<DeadlinePolicyDto> {
    return this.policies.update(dto);
  }
}
