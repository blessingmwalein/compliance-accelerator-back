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
import { RequirePermission } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import {
  BusinessUnitDto,
  BusinessUnitListQueryDto,
  BusinessUnitPageDto,
  BusinessUnitVersionDto,
  CreateBusinessUnitDto,
  UpdateBusinessUnitDto,
} from './business-units.dto.js';
import { BusinessUnitsService } from './business-units.service.js';

/** The organisation's business units. Archiving is the "delete": units are never removed. */
@ApiTags('business-units')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or the business unit does not exist.',
)
@Controller('organisations/:organisationId/business-units')
export class BusinessUnitsController {
  constructor(private readonly units: BusinessUnitsService) {}

  @Get()
  @RequirePermission('businessUnits.view')
  @ApiOperation({ operationId: 'listBusinessUnits', summary: 'List the business units' })
  @ApiOkResponse({ type: BusinessUnitPageDto })
  list(@Query() query: BusinessUnitListQueryDto): Promise<BusinessUnitPageDto> {
    return this.units.list(query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('businessUnits.create')
  @ApiOperation({ operationId: 'createBusinessUnit', summary: 'Create a business unit' })
  @ApiCreatedResponse({ type: BusinessUnitDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed.')
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`BUSINESS_UNIT_NAME_TAKEN` or `BUSINESS_UNIT_CODE_TAKEN`.',
  )
  create(@Body() dto: CreateBusinessUnitDto): Promise<BusinessUnitDto> {
    return this.units.create(dto);
  }

  @Patch(':businessUnitId')
  @RequirePermission('businessUnits.edit')
  @ApiOperation({ operationId: 'updateBusinessUnit', summary: 'Change a business unit' })
  @ApiOkResponse({ type: BusinessUnitDto })
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`VERSION_CONFLICT`, `BUSINESS_UNIT_NAME_TAKEN` or `BUSINESS_UNIT_CODE_TAKEN`.',
  )
  update(
    @Param('businessUnitId', ParseUUIDPipe) businessUnitId: string,
    @Body() dto: UpdateBusinessUnitDto,
  ): Promise<BusinessUnitDto> {
    return this.units.update(businessUnitId, dto);
  }

  /** Archives the unit: hidden from pickers, kept for history. Idempotent. */
  @Post(':businessUnitId/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('businessUnits.delete')
  @ApiOperation({ operationId: 'archiveBusinessUnit', summary: 'Archive a business unit' })
  @ApiOkResponse({ type: BusinessUnitDto })
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`: changed by someone else.')
  archive(
    @Param('businessUnitId', ParseUUIDPipe) businessUnitId: string,
    @Body() dto: BusinessUnitVersionDto,
  ): Promise<BusinessUnitDto> {
    return this.units.archive(businessUnitId, dto);
  }

  @Post(':businessUnitId/unarchive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('businessUnits.delete')
  @ApiOperation({
    operationId: 'unarchiveBusinessUnit',
    summary: 'Restore an archived business unit',
  })
  @ApiOkResponse({ type: BusinessUnitDto })
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`VERSION_CONFLICT`, or the name or code was taken meanwhile.',
  )
  unarchive(
    @Param('businessUnitId', ParseUUIDPipe) businessUnitId: string,
    @Body() dto: BusinessUnitVersionDto,
  ): Promise<BusinessUnitDto> {
    return this.units.unarchive(businessUnitId, dto);
  }
}
