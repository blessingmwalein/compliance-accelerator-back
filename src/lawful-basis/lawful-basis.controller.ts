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
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { OrganisationMember, RequirePermission } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import {
  CreateLawfulBasisRecordDto,
  LawfulBasisRecordDetailDto,
  LawfulBasisRecordDto,
  LawfulBasisRecordPageDto,
  LawfulBasisRecordVersionDto,
  LinkLawfulBasisEvidenceDto,
  ListLawfulBasisQueryDto,
  ReviewLawfulBasisRecordDto,
  UpdateLawfulBasisRecordDto,
} from './lawful-basis.dto.js';
import { LawfulBasisService } from './lawful-basis.service.js';

/**
 * The lawful basis register. Records are archived, never deleted, and an approval is a decision with its
 * own endpoint: the permission it needs (`governance.approve`) is decided in the service, which knows the
 * record and the step being taken.
 */
@ApiTags('lawful-basis')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or the lawful basis record does not exist.',
)
@Controller('organisations/:organisationId/lawful-basis')
export class LawfulBasisController {
  constructor(private readonly basis: LawfulBasisService) {}

  @Get()
  @RequirePermission('data.view')
  @ApiOperation({
    operationId: 'listLawfulBasisRecords',
    summary: 'List the lawful basis records',
  })
  @ApiOkResponse({ type: LawfulBasisRecordPageDto })
  list(@Query() query: ListLawfulBasisQueryDto): Promise<LawfulBasisRecordPageDto> {
    return this.basis.list(query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('data.create')
  @ApiOperation({
    operationId: 'createLawfulBasisRecord',
    summary: 'Record a lawful basis',
  })
  @ApiCreatedResponse({ type: LawfulBasisRecordDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed (unknown subject id, activity that is not ours, owner who is not an active member).',
  )
  create(@Body() dto: CreateLawfulBasisRecordDto): Promise<LawfulBasisRecordDto> {
    return this.basis.create(dto);
  }

  @Get(':recordId')
  @RequirePermission('data.view')
  @ApiOperation({ operationId: 'getLawfulBasisRecord', summary: 'One lawful basis record' })
  @ApiOkResponse({ type: LawfulBasisRecordDetailDto })
  detail(@Param('recordId', ParseUUIDPipe) recordId: string): Promise<LawfulBasisRecordDetailDto> {
    return this.basis.detail(recordId);
  }

  /** Content only: the review status is never changed here (see `POST …/review`). */
  @Patch(':recordId')
  @RequirePermission('data.edit')
  @ApiOperation({
    operationId: 'updateLawfulBasisRecord',
    summary: 'Change a lawful basis record',
  })
  @ApiOkResponse({ type: LawfulBasisRecordDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed.')
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`, or the record is archived.')
  update(
    @Param('recordId', ParseUUIDPipe) recordId: string,
    @Body() dto: UpdateLawfulBasisRecordDto,
  ): Promise<LawfulBasisRecordDto> {
    return this.basis.update(recordId, dto);
  }

  /**
   * The review decision. Declared as `@OrganisationMember()` because the rule is not one permission: a
   * step into or out of APPROVED needs `governance.approve`, and the service refuses anything else.
   */
  @Post(':recordId/review')
  @HttpCode(HttpStatus.OK)
  @OrganisationMember()
  @ApiOperation({
    operationId: 'reviewLawfulBasisRecord',
    summary: 'Take a basis record into review, approve it, or take an approval back',
  })
  @ApiOkResponse({ type: LawfulBasisRecordDetailDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    '`VALIDATION_FAILED`: a reason or a justification is missing.',
  )
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`VERSION_CONFLICT` or `INVALID_TRANSITION`: this step is not in the review lifecycle.',
  )
  review(
    @Param('recordId', ParseUUIDPipe) recordId: string,
    @Body() dto: ReviewLawfulBasisRecordDto,
  ): Promise<LawfulBasisRecordDetailDto> {
    return this.basis.review(recordId, dto);
  }

  @Post(':recordId/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('data.delete')
  @ApiOperation({
    operationId: 'archiveLawfulBasisRecord',
    summary: 'Archive a lawful basis record',
  })
  @ApiOkResponse({ type: LawfulBasisRecordDto })
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`: changed by someone else.')
  archive(
    @Param('recordId', ParseUUIDPipe) recordId: string,
    @Body() dto: LawfulBasisRecordVersionDto,
  ): Promise<LawfulBasisRecordDto> {
    return this.basis.archive(recordId, dto);
  }

  @Post(':recordId/unarchive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('data.delete')
  @ApiOperation({
    operationId: 'unarchiveLawfulBasisRecord',
    summary: 'Restore an archived lawful basis record',
  })
  @ApiOkResponse({ type: LawfulBasisRecordDto })
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`: changed by someone else.')
  unarchive(
    @Param('recordId', ParseUUIDPipe) recordId: string,
    @Body() dto: LawfulBasisRecordVersionDto,
  ): Promise<LawfulBasisRecordDto> {
    return this.basis.unarchive(recordId, dto);
  }

  /** Attaches an evidence file this organisation has uploaded. Linking the same file twice changes nothing. */
  @Post(':recordId/evidence')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('data.edit')
  @ApiOperation({
    operationId: 'linkLawfulBasisEvidence',
    summary: 'Attach evidence to a basis record',
  })
  @ApiOkResponse({ type: LawfulBasisRecordDetailDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, '`VALIDATION_FAILED`: the file is not one of ours.')
  link(
    @Param('recordId', ParseUUIDPipe) recordId: string,
    @Body() dto: LinkLawfulBasisEvidenceDto,
  ): Promise<LawfulBasisRecordDetailDto> {
    return this.basis.linkEvidence(recordId, dto.evidenceId);
  }

  @Delete(':recordId/evidence/:evidenceId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('data.edit')
  @ApiOperation({
    operationId: 'unlinkLawfulBasisEvidence',
    summary: 'Detach evidence from a basis record (the file itself stays)',
  })
  @ApiOkResponse({ type: LawfulBasisRecordDetailDto })
  unlink(
    @Param('recordId', ParseUUIDPipe) recordId: string,
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
  ): Promise<LawfulBasisRecordDetailDto> {
    return this.basis.unlinkEvidence(recordId, evidenceId);
  }
}
