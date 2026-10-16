import { Body, Controller, Get, HttpStatus, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PlatformOnly } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import { PlanDto, UpdatePlanVisibilityDto } from '../plans/plans.dto.js';
import { PlansService } from '../plans/plans.service.js';

/** Plan catalogue administration. Visibility decides what is OFFERED; it never changes an organisation that already has the plan. */
@ApiTags('platform')
@PlatformOnly('platform.plans.manage')
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, 'The caller is not a platform administrator.')
@Controller('platform/plans')
export class PlatformPlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @ApiOperation({ operationId: 'listAllPlans', summary: 'Every plan, including hidden ones' })
  @ApiOkResponse({ type: PlanDto, isArray: true })
  list(): Promise<PlanDto[]> {
    return this.plans.listAll();
  }

  @Patch(':planId')
  @ApiOperation({ operationId: 'setPlanVisibility', summary: 'Show or hide a plan' })
  @ApiOkResponse({ type: PlanDto })
  @ApiProblemResponse(HttpStatus.NOT_FOUND, 'No such plan.')
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`: changed by someone else.')
  setVisibility(
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: UpdatePlanVisibilityDto,
  ): Promise<PlanDto> {
    return this.plans.setVisibility(planId, dto);
  }
}
