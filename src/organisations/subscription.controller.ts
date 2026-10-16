import { Controller, Get, HttpStatus } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import { SubscriptionDto } from '../plans/plans.dto.js';
import { EntitlementsService } from './entitlements.service.js';

@ApiTags('plans')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation (or it does not exist).',
)
@Controller('organisations/:organisationId/subscription')
export class SubscriptionController {
  constructor(private readonly entitlements: EntitlementsService) {}

  /** The organisation's plan snapshot and how much of it is used. No plan assigned = nothing is limited. */
  @Get()
  @RequirePermission('subscription.view')
  @ApiOperation({ operationId: 'getSubscription', summary: "The organisation's plan and usage" })
  @ApiOkResponse({ type: SubscriptionDto })
  get(): Promise<SubscriptionDto> {
    return this.entitlements.describe();
  }
}
