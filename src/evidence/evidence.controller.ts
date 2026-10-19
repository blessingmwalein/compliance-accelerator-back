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
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { OrganisationMember, RequirePermission } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import { contentDisposition } from '../common/http/content-disposition.js';
import {
  AttestEvidenceScanDto,
  ChangeEvidenceReviewDto,
  DownloadEvidenceQueryDto,
  EvidenceDetailDto,
  EvidenceDto,
  EvidenceListQueryDto,
  EvidencePageDto,
  EvidenceVersionListDto,
  UpdateEvidenceDto,
  UploadEvidenceDto,
  UploadEvidenceVersionDto,
} from './evidence.dto.js';
import { EVIDENCE_CONTENT_TYPES, MAX_EVIDENCE_BYTES, EvidenceService } from './evidence.service.js';

/** What the upload interceptor hands over: the bytes are kept in memory, the name is the one the client sent. */
interface UploadedEvidenceFile {
  buffer?: Buffer;
  originalname?: string;
}

/**
 * The organisation's evidence repository: uploaded bytes in private storage, one version ledger per item,
 * an owner, a review state machine and a scan attestation. Metadata and checksum live in the database and
 * downloads are proxied through this authorised endpoint (never a public or guessable URL).
 */
@ApiTags('evidence')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or the evidence (or a named version) does not exist.',
)
@Controller('organisations/:organisationId/evidence')
export class EvidenceController {
  constructor(private readonly evidence: EvidenceService) {}

  @Get()
  @RequirePermission('governance.view')
  @ApiOperation({ operationId: 'listEvidence', summary: 'List the evidence files' })
  @ApiOkResponse({ type: EvidencePageDto })
  list(@Query() query: EvidenceListQueryDto): Promise<EvidencePageDto> {
    return this.evidence.list(query);
  }

  /**
   * Uploads one file with its title, starting the version ledger at 1. The type is decided from the bytes
   * (PDF, PNG, JPEG, GIF, plain text or CSV) and the size cap is 10 MiB; the checksum and size are measured
   * here, never taken from the client.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('governance.edit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_EVIDENCE_BYTES, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadEvidenceDto })
  @ApiOperation({ operationId: 'uploadEvidence', summary: 'Upload an evidence file' })
  @ApiCreatedResponse({ type: EvidenceDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed: a title and a non-empty file.')
  @ApiProblemResponse(HttpStatus.PAYLOAD_TOO_LARGE, 'The file is larger than 10 MiB.')
  @ApiProblemResponse(
    HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    'The file is not a PDF, PNG, JPEG, GIF, plain text or CSV.',
  )
  upload(
    @Body() dto: UploadEvidenceDto,
    @UploadedFile() file: UploadedEvidenceFile | undefined,
  ): Promise<EvidenceDto> {
    return this.evidence.upload(dto, file?.buffer, file?.originalname);
  }

  /** One file with its review and scan detail and the records it is attached to (links are read-only here). */
  @Get(':evidenceId')
  @RequirePermission('governance.view')
  @ApiOperation({ operationId: 'getEvidence', summary: 'Read one evidence file' })
  @ApiOkResponse({ type: EvidenceDetailDto })
  get(@Param('evidenceId', ParseUUIDPipe) evidenceId: string): Promise<EvidenceDetailDto> {
    return this.evidence.get(evidenceId);
  }

  /**
   * Changes the title, the description or the owner. The file itself cannot be replaced here: that is a
   * new version. `ownerMembershipId` must name an active member of this organisation.
   */
  @Patch(':evidenceId')
  @RequirePermission('governance.edit')
  @ApiOperation({
    operationId: 'updateEvidence',
    summary: 'Change the metadata and owner of an evidence file',
  })
  @ApiOkResponse({ type: EvidenceDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed: a title cannot be cleared, or the owner is not an active member.',
  )
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`: changed by someone else.')
  update(
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
    @Body() dto: UpdateEvidenceDto,
  ): Promise<EvidenceDto> {
    return this.evidence.update(evidenceId, dto);
  }

  /**
   * Uploads a new version of an existing record. The new file is the current one, the scan attestation
   * goes back to NOT_SCANNED and the review loses the judgement made about the superseded bytes: an old
   * attestation never covers new bytes.
   */
  @Post(':evidenceId/versions')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('governance.edit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_EVIDENCE_BYTES, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadEvidenceVersionDto })
  @ApiOperation({
    operationId: 'uploadEvidenceVersion',
    summary: 'Upload a new version of an evidence file',
  })
  @ApiCreatedResponse({ type: EvidenceDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed: a non-empty file.')
  @ApiProblemResponse(HttpStatus.PAYLOAD_TOO_LARGE, 'The file is larger than 10 MiB.')
  @ApiProblemResponse(
    HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    'The file is not a PDF, PNG, JPEG, GIF, plain text or CSV.',
  )
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`VERSION_CONFLICT`: another version landed first. Reload and try again.',
  )
  uploadVersion(
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
    @Body() dto: UploadEvidenceVersionDto,
    @UploadedFile() file: UploadedEvidenceFile | undefined,
  ): Promise<EvidenceDto> {
    return this.evidence.uploadVersion(evidenceId, dto, file?.buffer, file?.originalname);
  }

  /** The version ledger of one record, ordered by number. Short, so never paginated, never the storage key. */
  @Get(':evidenceId/versions')
  @RequirePermission('governance.view')
  @ApiOperation({
    operationId: 'listEvidenceVersions',
    summary: 'List the versions of an evidence file',
  })
  @ApiOkResponse({ type: EvidenceVersionListDto })
  listVersions(
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
  ): Promise<EvidenceVersionListDto> {
    return this.evidence.listVersions(evidenceId);
  }

  /**
   * One step along the review lifecycle. The route is open to any active member because the permission
   * depends on the step (an approver's move needs `governance.approve`, a work move `governance.edit`) and
   * the service, which has the row, decides.
   */
  @Post(':evidenceId/review')
  @HttpCode(HttpStatus.OK)
  @OrganisationMember()
  @ApiOperation({
    operationId: 'changeEvidenceReview',
    summary: "Change an evidence file's review state",
  })
  @ApiOkResponse({ type: EvidenceDetailDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed: a reason the step requires is missing, or the state is already the one asked for.',
  )
  @ApiProblemResponse(
    HttpStatus.FORBIDDEN,
    'The step belongs to an approver and the caller is not one.',
  )
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`INVALID_TRANSITION` (the table lists the moves that exist) or `VERSION_CONFLICT`.',
  )
  changeReview(
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
    @Body() dto: ChangeEvidenceReviewDto,
  ): Promise<EvidenceDetailDto> {
    return this.evidence.changeReview(evidenceId, dto);
  }

  /**
   * Attest the scan result of the CURRENT version as a dated, attributed statement. NOT_SCANNED is refused
   * (it is the absence of an attestation), and a bad result needs a note.
   */
  @Post(':evidenceId/scan')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('governance.edit')
  @ApiOperation({
    operationId: 'attestEvidenceScan',
    summary: 'Attest the scan of the current version',
  })
  @ApiOkResponse({ type: EvidenceDetailDto })
  @ApiProblemResponse(
    HttpStatus.BAD_REQUEST,
    'Validation failed: NOT_SCANNED is not an attestation, or a required note is missing.',
  )
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`: changed by someone else.')
  attestScan(
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
    @Body() dto: AttestEvidenceScanDto,
  ): Promise<EvidenceDetailDto> {
    return this.evidence.attestScan(evidenceId, dto);
  }

  /**
   * The bytes, streamed back through this authorised endpoint by someone who may read the record: there is
   * no public URL for evidence. Without `?version=` the current version is served; a version the ledger
   * never had answers `EVIDENCE_VERSION_NOT_FOUND`. The `ETag` is the stored checksum, so a re-check of an
   * unchanged file is a 304 without sending it again.
   */
  @Get(':evidenceId/download')
  @RequirePermission('governance.view')
  @ApiOperation({
    operationId: 'downloadEvidence',
    summary: 'Download an evidence file (proxied, with attachment disposition)',
  })
  @ApiQuery({
    name: 'version',
    type: Number,
    required: false,
    minimum: 1,
    description: 'The version number to download; omit for the current one.',
  })
  @ApiProduces(...EVIDENCE_CONTENT_TYPES)
  @ApiOkResponse({ description: 'The file bytes.', schema: { type: 'string', format: 'binary' } })
  @ApiProblemResponse(
    HttpStatus.NOT_FOUND,
    '`NOT_FOUND` for no such evidence (or its stored file is missing); `EVIDENCE_VERSION_NOT_FOUND` for a version this item never had.',
  )
  async download(
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
    @Query() query: DownloadEvidenceQueryDto,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.evidence.download(evidenceId, query.version);
    const etag = `"${file.sha256}"`;
    response.setHeader('ETag', etag);
    // private: it is served to authorised members only; the browser revalidates instead of trusting a stale copy
    response.setHeader('Cache-Control', 'private, no-cache');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'");
    // The name was already stripped of directory parts and control characters when it was stored.
    response.setHeader('Content-Disposition', contentDisposition(file.filename, 'evidence'));
    if (request.headers['if-none-match'] === etag) {
      response.status(HttpStatus.NOT_MODIFIED).end();
      return;
    }
    response.setHeader('Content-Type', file.contentType);
    response.setHeader('Content-Length', String(file.data.length));
    response.status(HttpStatus.OK).end(file.data);
  }
}
