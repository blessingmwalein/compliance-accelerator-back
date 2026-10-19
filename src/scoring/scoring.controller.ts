import { Body, Controller, Get, HttpStatus, Patch } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import { ScoringDto, UpdateScoringDto } from './scoring.dto.js';
import { ScoringService } from './scoring.service.js';

/**
 * The scoring and scheduling policy of one organisation: the exposure bands, the remediation due days and
 * the Plan window. Reference values the organisation may change; nothing here is a legal rule.
 */
@ApiTags('scoring')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or it does not exist.',
)
@Controller('organisations/:organisationId/scoring')
export class ScoringController {
  constructor(private readonly scoring: ScoringService) {}

  /** The policy in force, with the scales, the Eisenhower questions and the reference defaults to reset to. */
  @Get()
  @RequirePermission('governance.view')
  @ApiOperation({ operationId: 'getScoring', summary: 'The scoring and scheduling policy' })
  @ApiOkResponse({ type: ScoringDto })
  get(): Promise<ScoringDto> {
    return this.scoring.get();
  }

  /** Omit a field to keep it; send `null` to return that part to the reference default. */
  @Patch()
  @RequirePermission('governance.edit')
  @ApiOperation({ operationId: 'updateScoring', summary: 'Change the scoring policy' })
  @ApiOkResponse({ type: ScoringDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed.')
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`: changed by someone else.')
  update(@Body() dto: UpdateScoringDto): Promise<ScoringDto> {
    return this.scoring.update(dto);
  }
}
