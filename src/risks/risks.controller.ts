import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { OrganisationMember, RequirePermission } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import {
  AcceptRiskDto,
  ChangeRiskStatusDto,
  CreateRiskDto,
  ListRisksQueryDto,
  RiskAcceptancePageDto,
  RiskDetailDto,
  RiskDto,
  RiskHeatmapDto,
  RiskHeatmapQueryDto,
  RiskPageDto,
  RiskSummaryDto,
  UpdateRiskDto,
  WithdrawRiskAcceptanceDto,
} from './risks.dto.js';
import { RisksService } from './risks.service.js';

/**
 * The risk register: the risks themselves, their status lifecycle, the acceptance ledger, and the two
 * views the register exists to give (the counts and the 5×5 heat map).
 *
 * Reading and writing register content takes the governance permissions — a risk is governance work, not a
 * data record. The status endpoint declares `@OrganisationMember()` because its rule is per-row and
 * per-step (some steps belong to an approver, the rest to an editor) and the service, which has the row,
 * decides. Accepting a risk and withdrawing an acceptance are decisions about exposure the organisation
 * carries, so both take `governance.approve`. Nothing here deletes a risk: the lifecycle ends at CLOSED
 * and the acceptance ledger only ever grows.
 */
@ApiTags('risks')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or the risk does not exist.',
)
@Controller('organisations/:organisationId/risks')
export class RisksController {
  constructor(private readonly risks: RisksService) {}

  /** `summary` and `heatmap` are declared before `:riskId` so their words are never read as an id. */
  @Get('summary')
  @RequirePermission('governance.view')
  @ApiOperation({
    operationId: 'getRiskSummary',
    summary: 'The register counted: by status, by level, by review state',
  })
  @ApiOkResponse({ type: RiskSummaryDto })
  summary(): Promise<RiskSummaryDto> {
    return this.risks.summary();
  }

  /** The 5×5 grid on either basis. Closed risks are history, not exposure, so they are not plotted. */
  @Get('heatmap')
  @RequirePermission('governance.view')
  @ApiOperation({ operationId: 'getRiskHeatmap', summary: 'The risk matrix, as a heat map' })
  @ApiOkResponse({ type: RiskHeatmapDto })
  heatmap(@Query() query: RiskHeatmapQueryDto): Promise<RiskHeatmapDto> {
    return this.risks.heatmap(query.basis ?? 'residual');
  }

  @Get()
  @RequirePermission('governance.view')
  @ApiOperation({ operationId: 'listRisks', summary: 'List the risk register' })
  @ApiOkResponse({ type: RiskPageDto })
  list(@Query() query: ListRisksQueryDto): Promise<RiskPageDto> {
    return this.risks.list(query);
  }

  /**
   * Write a risk. The caller states the factors; the score and the band beside them are derived here and
   * cannot be sent. A new risk is OPEN, or IN_TREATMENT when work on it has already begun.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('governance.create')
  @ApiOperation({ operationId: 'createRisk', summary: 'Add a risk to the register' })
  @ApiCreatedResponse({ type: RiskDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (unknown subject or owner, a residual factor above its inherent one).',
  )
  create(@Body() dto: CreateRiskDto): Promise<RiskDto> {
    return this.risks.create(dto);
  }

  @Get(':riskId')
  @RequirePermission('governance.view')
  @ApiOperation({ operationId: 'getRisk', summary: 'One risk, with its acceptance ledger' })
  @ApiOkResponse({ type: RiskDetailDto })
  detail(@Param('riskId', ParseUUIDPipe) riskId: string): Promise<RiskDetailDto> {
    return this.risks.detail(riskId);
  }

  /**
   * The register's content: text, links, owner, and the factors. The status has its own endpoint and so
   * does acceptance, because both are decisions with their own rules and their own trail.
   */
  @Patch(':riskId')
  @RequirePermission('governance.edit')
  @ApiOperation({ operationId: 'updateRisk', summary: 'Change a risk' })
  @ApiOkResponse({ type: RiskDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed.')
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`: changed by someone else.')
  update(
    @Param('riskId', ParseUUIDPipe) riskId: string,
    @Body() dto: UpdateRiskDto,
  ): Promise<RiskDto> {
    return this.risks.update(riskId, dto);
  }

  /**
   * One step along the lifecycle, as the transition table defines it. Steps out of ACCEPTED and out of
   * CLOSED belong to an approver and need a reason; into ACCEPTED there is no step at all, so this route
   * refuses it with 409 `INVALID_TRANSITION`.
   */
  @Post(':riskId/status')
  @HttpCode(HttpStatus.OK)
  @OrganisationMember()
  @ApiOperation({ operationId: 'changeRiskStatus', summary: "Change a risk's status" })
  @ApiOkResponse({ type: RiskDetailDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (a reason the step requires is missing, or the status is already the one asked for).',
  )
  @ApiProblemResponse(
    HttpStatus.FORBIDDEN,
    'The step belongs to an approver and the caller is not one.',
  )
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`INVALID_TRANSITION` (the table lists the steps that exist, and there is no step into ACCEPTED) or `VERSION_CONFLICT`.',
  )
  changeStatus(
    @Param('riskId', ParseUUIDPipe) riskId: string,
    @Body() dto: ChangeRiskStatusDto,
  ): Promise<RiskDetailDto> {
    return this.risks.changeStatus(riskId, dto);
  }

  /** Every acceptance decision ever taken on this risk, newest first. Short, so never paginated. */
  @Get(':riskId/acceptances')
  @RequirePermission('governance.view')
  @ApiOperation({
    operationId: 'listRiskAcceptances',
    summary: 'The acceptance ledger of one risk',
  })
  @ApiOkResponse({ type: RiskAcceptancePageDto })
  listAcceptances(@Param('riskId', ParseUUIDPipe) riskId: string): Promise<RiskAcceptancePageDto> {
    return this.risks.listAcceptances(riskId);
  }

  /**
   * Accept the risk that is left. The risk has to carry its inherent pair (an acceptance without a level
   * accepts nothing), and the decision is written to the ledger before the status follows it.
   */
  @Post(':riskId/acceptances')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('governance.approve')
  @ApiOperation({ operationId: 'acceptRisk', summary: 'Accept a risk' })
  @ApiCreatedResponse({ type: RiskDetailDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (no inherent factors to accept, an expiry in the past, a review after the expiry).',
  )
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`RISK_ACCEPTANCE_IN_FORCE` (already accepted), `RISK_NOT_ACCEPTABLE` (closed or transferred), or `VERSION_CONFLICT`.',
  )
  accept(
    @Param('riskId', ParseUUIDPipe) riskId: string,
    @Body() dto: AcceptRiskDto,
  ): Promise<RiskDetailDto> {
    return this.risks.accept(riskId, dto);
  }

  /** Stop accepting it: the ledger gets the withdrawal and the caller says where the risk goes. */
  @Post(':riskId/acceptances/withdraw')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('governance.approve')
  @ApiOperation({ operationId: 'withdrawRiskAcceptance', summary: 'Withdraw an acceptance' })
  @ApiOkResponse({ type: RiskDetailDto })
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`VERSION_CONFLICT`: changed by someone else. Nothing that is not an accepted risk has an acceptance to withdraw.',
  )
  withdrawAcceptance(
    @Param('riskId', ParseUUIDPipe) riskId: string,
    @Body() dto: WithdrawRiskAcceptanceDto,
  ): Promise<RiskDetailDto> {
    return this.risks.withdrawAcceptance(riskId, dto);
  }
}
