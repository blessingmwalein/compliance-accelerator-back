import {
  Body,
  Controller,
  Delete,
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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import { PageQueryDto } from '../common/pagination.js';
import { RegulatorContactsService } from './regulator-contacts.service.js';
import {
  CreateRegulatorContactDto,
  RegulatorContactDto,
  RegulatorContactPageDto,
  UpdateRegulatorContactDto,
} from './settings.dto.js';

/** The regulators and supervisory authorities the organisation reports to (typed in by the organisation). */
@ApiTags('settings')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or the contact does not exist.',
)
@Controller('organisations/:organisationId/regulator-contacts')
export class RegulatorContactsController {
  constructor(private readonly contacts: RegulatorContactsService) {}

  @Get()
  @RequirePermission('company.view')
  @ApiOperation({ operationId: 'listRegulatorContacts', summary: 'List the regulator contacts' })
  @ApiOkResponse({ type: RegulatorContactPageDto })
  list(@Query() query: PageQueryDto): Promise<RegulatorContactPageDto> {
    return this.contacts.list(query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('company.edit')
  @ApiOperation({ operationId: 'createRegulatorContact', summary: 'Add a regulator contact' })
  @ApiCreatedResponse({ type: RegulatorContactDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed.')
  create(@Body() dto: CreateRegulatorContactDto): Promise<RegulatorContactDto> {
    return this.contacts.create(dto);
  }

  @Patch(':contactId')
  @RequirePermission('company.edit')
  @ApiOperation({ operationId: 'updateRegulatorContact', summary: 'Change a regulator contact' })
  @ApiOkResponse({ type: RegulatorContactDto })
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`: changed by someone else.')
  update(
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Body() dto: UpdateRegulatorContactDto,
  ): Promise<RegulatorContactDto> {
    return this.contacts.update(contactId, dto);
  }

  @Delete(':contactId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('company.edit')
  @ApiOperation({ operationId: 'deleteRegulatorContact', summary: 'Remove a regulator contact' })
  @ApiNoContentResponse({ description: 'The contact was removed.' })
  remove(@Param('contactId', ParseUUIDPipe) contactId: string): Promise<void> {
    return this.contacts.remove(contactId);
  }
}
