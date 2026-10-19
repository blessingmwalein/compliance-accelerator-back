import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import {
  AdjustItemPriorityDto,
  ClearItemPriorityAdjustmentDto,
  ItemPriorityDetailDto,
  PriorityItemPageDto,
  PriorityListQueryDto,
  PriorityMatrixDto,
  SaveItemPriorityDto,
} from './priorities.dto.js';
import { PrioritiesService } from './priorities.service.js';

/**
 * The Eisenhower priority matrix of the organisation: the answers people give about an item, the flags and
 * quadrant the ruleset derives from them, and an authorised person's adjustment of a flag.
 *
 * Nothing here scores or approves an assessment. A priority is triage: it stays editable while its assessment
 * is APPROVED, while the assessed item itself is read-only (its content freezes once the assessment leaves
 * DRAFT).
 */
@ApiTags('priorities')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or the assessment item does not exist in it.',
)
@Controller('organisations/:organisationId')
export class PrioritiesController {
  constructor(private readonly priorities: PrioritiesService) {}

  /**
   * The four quadrant counts plus the items the rule cannot place, and the question text, scales and wording
   * a client needs to show them. Quadrants are derived from the saved answers on every read.
   */
  @Get('priority-matrix')
  @RequirePermission('governance.view')
  @ApiOperation({
    operationId: 'getPriorityMatrix',
    summary: 'The priority matrix: quadrant counts and the criteria behind them',
  })
  @ApiOkResponse({ type: PriorityMatrixDto })
  matrix(): Promise<PriorityMatrixDto> {
    return this.priorities.matrix();
  }

  /** A cursor page of items with their derived urgency, importance and quadrant. */
  @Get('priority-matrix/items')
  @RequirePermission('governance.view')
  @ApiOperation({ operationId: 'listPriorityItems', summary: 'List items with their priority' })
  @ApiOkResponse({ type: PriorityItemPageDto })
  list(@Query() query: PriorityListQueryDto): Promise<PriorityItemPageDto> {
    return this.priorities.list(query);
  }

  /** One item: the answers behind its quadrant, the adjustment with its reason, the related tasks. */
  @Get('assessment-items/:itemId/priority')
  @RequirePermission('governance.view')
  @ApiOperation({
    operationId: 'getItemPriority',
    summary: 'Read one item priority with its criteria',
  })
  @ApiOkResponse({ type: ItemPriorityDetailDto })
  get(@Param('itemId', ParseUUIDPipe) itemId: string): Promise<ItemPriorityDetailDto> {
    return this.priorities.get(itemId);
  }

  /**
   * Saves the full answer set of the item. A key left out (or sent as null) is NOT ANSWERED, which is never
   * the same as No; the first save creates the row.
   */
  @Put('assessment-items/:itemId/priority')
  @RequirePermission('governance.edit')
  @ApiOperation({ operationId: 'saveItemPriority', summary: 'Save an item priority questionnaire' })
  @ApiOkResponse({ type: ItemPriorityDetailDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed.')
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`VERSION_CONFLICT`: the priority changed since it was read, or does not exist yet with that version.',
  )
  save(
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: SaveItemPriorityDto,
  ): Promise<ItemPriorityDetailDto> {
    return this.priorities.save(itemId, dto);
  }

  /** Overrides a derived flag, with a reason. Needs the approve permission; every change is audited. */
  @Post('assessment-items/:itemId/priority/adjust')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('governance.approve')
  @ApiOperation({ operationId: 'adjustItemPriority', summary: 'Adjust an item priority flag' })
  @ApiOkResponse({ type: ItemPriorityDetailDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed: the reason is required.')
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`VERSION_CONFLICT`, or the item has no answers to adjust yet.',
  )
  adjust(
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: AdjustItemPriorityDto,
  ): Promise<ItemPriorityDetailDto> {
    return this.priorities.adjust(itemId, dto);
  }

  /** Withdraws both overrides, so the flags follow the saved answers again. The reason is still required. */
  @Post('assessment-items/:itemId/priority/clear-adjustment')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('governance.approve')
  @ApiOperation({
    operationId: 'clearItemPriorityAdjustment',
    summary: 'Withdraw an item priority adjustment',
  })
  @ApiOkResponse({ type: ItemPriorityDetailDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed: the reason is required.')
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`.')
  clearAdjustment(
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: ClearItemPriorityAdjustmentDto,
  ): Promise<ItemPriorityDetailDto> {
    return this.priorities.clearAdjustment(itemId, dto);
  }
}
