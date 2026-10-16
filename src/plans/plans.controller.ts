import { Controller, Get, HttpStatus } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authenticated } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import { PlanDto } from './plans.dto.js';
import { PlansService } from './plans.service.js';

@ApiTags('plans')
@Controller('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  /** The plans that are currently offered. (Limits marked as placeholders are not commercial commitments.) */
  @Get()
  @Authenticated()
  @ApiOperation({ operationId: 'listPlans', summary: 'The plans on offer' })
  @ApiOkResponse({ type: PlanDto, isArray: true })
  @ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
  list(): Promise<PlanDto[]> {
    return this.plans.listVisible();
  }
}
