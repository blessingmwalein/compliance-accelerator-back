import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PageQueryDto } from '../common/pagination.js';
import { OptionalOrNull, TrimText, TrimToNull } from '../common/validators/nullable.js';
import {
  EVIDENCE_REVIEW_STATUSES,
  EVIDENCE_SCAN_STATES,
  type EvidenceReviewStatus,
  type EvidenceScanState,
} from '../domain/incidents/evidence.js';

/**
 * An uploaded evidence file: what it is, who owns and reviews it, and how its current version was
 * verified — never the bytes (those come from the download endpoint, through the same permission check)
 * and never the storage key (an opaque place, known only to the service).
 */
export class EvidenceDto {
  id!: string;
  /** The label the uploader gave it (1 to 200 characters). */
  title!: string;
  description!: string | null;
  /** The file name of the CURRENT version as the uploader called it, sanitised. Display only. */
  originalFilename!: string;
  /** Decided by the server from the bytes, never from the client's `Content-Type` or extension. */
  contentType!: string;
  /** Size in bytes of the current version's stored file, measured by the server. */
  size!: number;
  /** SHA-256 (hex) of the current version's bytes, computed by the server. Also the download `ETag`. */
  sha256!: string;
  /** The member who uploaded the record (taken from the session, never from the request). */
  uploadedByUserId!: string;
  /** The version a plain download returns; the version rows are the whole history. */
  currentVersion!: number;
  /** The member accountable for this item; null = nobody owns it. */
  ownerMembershipId!: string | null;

  @ApiProperty({ enum: EVIDENCE_REVIEW_STATUSES, enumName: 'EvidenceReviewStatus' })
  reviewStatus!: EvidenceReviewStatus;
  /** The member who made the current review decision; present only for an ACCEPTED or REJECTED item. */
  reviewedByUserId!: string | null;

  @ApiProperty({ enum: EVIDENCE_SCAN_STATES, enumName: 'EvidenceScanState' })
  scanState!: EvidenceScanState;
  /** The calendar day the current version was scanned (`YYYY-MM-DD`); null while it is NOT_SCANNED. */
  scannedOn!: string | null;
  /** The member who attested the scan of the current version; null while it is NOT_SCANNED. */
  attestedByUserId!: string | null;

  /** ISO 8601 UTC instant of the upload. */
  createdAt!: string;
  /** ISO 8601 UTC instant of the last change. */
  updatedAt!: string;
  /** Send it back with every change: a stale value is rejected with 409 `VERSION_CONFLICT`. */
  version!: number;
}

export class EvidenceReviewTransitionDto {
  @ApiProperty({ enum: EVIDENCE_REVIEW_STATUSES, enumName: 'EvidenceReviewStatus' })
  toStatus!: EvidenceReviewStatus;
  /** `approve`: only an approver may make this move. `work`: anyone who may edit the repository. */
  @ApiProperty({ enum: ['work', 'approve'] })
  by!: 'work' | 'approve';
  /** A written reason has to come with the move. */
  needsReason!: boolean;
}

/**
 * One evidence file with its review and scan detail and the records it is attached to. Read-only links:
 * they are written by the modules that own them. The UI renders a full row from this without extra calls.
 */
export class EvidenceDetailDto extends EvidenceDto {
  /** The reviewer's note; required by a rejection so the uploader knows what to fix. */
  reviewNote!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  lastReviewDate!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  nextReviewDate!: string | null;
  /** The attester's note about the current version's scan; required for INFECTED and UNABLE_TO_SCAN. */
  scanNote!: string | null;
  /** Ids of the assessment items this file is attached to (empty when it is attached to nothing). */
  linkedItemIds!: string[];
  /** Ids of the remediation tasks this file is attached to (empty when it is attached to nothing). */
  linkedTaskIds!: string[];
  /** The review moves THIS caller may take now, so the UI never offers a forbidden one. */
  @ApiProperty({ type: [EvidenceReviewTransitionDto] })
  allowedTransitions!: EvidenceReviewTransitionDto[];
}

export class EvidencePageDto {
  items!: EvidenceDto[];
  /** Pass as `after` to get the next page; null on the last page. */
  nextCursor!: string | null;
}

export class EvidenceListQueryDto extends PageQueryDto {
  /** Only evidence whose title contains this text (case-insensitive). */
  @ApiPropertyOptional({ type: String, maxLength: 200 })
  @IsOptional()
  @TrimText()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ enum: EVIDENCE_REVIEW_STATUSES, enumName: 'EvidenceReviewStatus' })
  @IsOptional()
  @IsIn(EVIDENCE_REVIEW_STATUSES)
  reviewStatus?: EvidenceReviewStatus;

  @ApiPropertyOptional({ enum: EVIDENCE_SCAN_STATES, enumName: 'EvidenceScanState' })
  @IsOptional()
  @IsIn(EVIDENCE_SCAN_STATES)
  scanState?: EvidenceScanState;

  /** Only evidence owned by this member. */
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  ownerMembershipId?: string;
}

/**
 * Multipart body of an upload: the file plus its metadata. The file itself is read by the upload
 * interceptor (bytes never travel through this DTO), which bounds the body at 10 MiB; the cap this
 * deployment applies is the lower one and `GET /api/v1/meta` states it.
 */
export class UploadEvidenceDto {
  /** PDF, PNG, JPEG, GIF, plain text or CSV, up to the cap GET /api/v1/meta states. Type from the bytes. */
  @ApiProperty({ type: 'string', format: 'binary' })
  file!: unknown;

  /** The label the file is filed under (1 to 200 characters). Required, and never cleared afterwards. */
  @TrimText()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  /** What it shows (up to 2000 characters). */
  @ApiPropertyOptional({ type: String, maxLength: 2000 })
  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}

/**
 * Multipart body of a new version: the replacement file plus, optionally, why it replaced the last one.
 * The title and description stay on the record; only the bytes are versioned here.
 */
export class UploadEvidenceVersionDto {
  /** The new file: PDF, PNG, JPEG, GIF, plain text or CSV, up to the cap GET /api/v1/meta states. */
  @ApiProperty({ type: 'string', format: 'binary' })
  file!: unknown;

  /** Why it replaced the previous file (up to 1000 characters); null for a plain re-upload. */
  @ApiPropertyOptional({ type: String, maxLength: 1000 })
  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

/**
 * Metadata and ownership changes; `version` guards the write. The bytes cannot change here: that is a
 * new version. Omit a field to keep it; `description` and `ownerMembershipId` clear with `null` or a
 * blank value; `title` is required and cannot be cleared.
 */
export class UpdateEvidenceDto {
  /** Omit to keep it. `null` or blank is refused: a title is required and cannot be cleared. */
  @ApiPropertyOptional({ type: String, maxLength: 200 })
  @TrimText()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string | null;

  @ApiPropertyOptional({ type: String, maxLength: 2000, nullable: true })
  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  /** The accountable member. `null` or blank clears the owner; a value must be an active member. */
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @OptionalOrNull()
  @IsUUID()
  ownerMembershipId?: string | null;

  /** The `version` of the evidence record as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

/**
 * One step along the review lifecycle. The step is not the reviewer's free text but their decision,
 * so an outcome records who made it and a rejection says why.
 */
export class ChangeEvidenceReviewDto {
  @ApiProperty({ enum: EVIDENCE_REVIEW_STATUSES, enumName: 'EvidenceReviewStatus' })
  @IsIn(EVIDENCE_REVIEW_STATUSES)
  toStatus!: EvidenceReviewStatus;

  /** Mandatory for the moves that say so (and always kept: a review decision is a judgement). */
  @ApiPropertyOptional({ type: String, maxLength: 4000, nullable: true })
  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(4000)
  note?: string | null;

  @IsInt()
  @Min(1)
  version!: number;
}

/** Attest the scan result of the CURRENT version: a dated statement by a named person, never NOT_SCANNED. */
export class AttestEvidenceScanDto {
  @ApiProperty({ enum: EVIDENCE_SCAN_STATES, enumName: 'EvidenceScanState' })
  @IsIn(EVIDENCE_SCAN_STATES)
  scanState!: EvidenceScanState;

  /** Required (3 to 1000 characters) for INFECTED and UNABLE_TO_SCAN; optional for CLEAN. */
  @ApiPropertyOptional({ type: String, maxLength: 1000, nullable: true })
  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(1000)
  note?: string | null;

  @IsInt()
  @Min(1)
  version!: number;
}

/** One stored file of an evidence record, newest history first. The storage key is never exposed. */
export class EvidenceVersionDto {
  number!: number;
  originalFilename!: string;
  contentType!: string;
  size!: number;
  sha256!: string;
  uploadedByUserId!: string;
  /** ISO 8601 UTC instant this version was uploaded. */
  createdAt!: string;
  /** Scan state applies only to the current version; a superseded file is not attested (`NOT_SCANNED`). */
  @ApiProperty({ enum: EVIDENCE_SCAN_STATES, enumName: 'EvidenceScanState' })
  scanState!: EvidenceScanState;
  /** Whether this is the version `currentVersion` points at (the one a plain download serves). */
  isCurrent!: boolean;
}

/** The version ledger of one item. Short, so it is never paginated. */
export class EvidenceVersionListDto {
  @ApiProperty({ type: [EvidenceVersionDto] })
  items!: EvidenceVersionDto[];
}

/** The download query: `version` names a historical file; without it the current version is served. */
export class DownloadEvidenceQueryDto {
  @ApiPropertyOptional({ type: Number, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}
