import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { IsIanaTimezone } from '../common/validators/is-iana-timezone.js';
import {
  EmailToNull,
  OptionalOrNull,
  TrimText,
  TrimToNull,
} from '../common/validators/nullable.js';

/** The organisation's company information, DPO contact and branding state. Blank values are `null` = "not provided". */
export class OrganisationSettingsDto {
  id!: string;
  /** The organisation's name. */
  name!: string;
  /** IANA time zone; deadlines and reminders are computed in it. */
  timezone!: string;
  /** How the organisation is shown to its members, when it differs from the name. */
  displayName!: string | null;
  legalName!: string | null;
  registrationNumber!: string | null;
  /** Industry or sector, free text. */
  sector!: string | null;
  /** Required for the organisation to be complete: null until it was first provided, and never cleared afterwards. */
  country!: string | null;
  address!: string | null;
  /** The designated Data Protection Officer contact. Not a role, and may be an external person. */
  dpoName!: string | null;
  /** Required for the organisation to be complete: null until it was first provided, and never cleared afterwards. */
  dpoEmail!: string | null;
  dpoPhone!: string | null;
  /** Whether a logo is stored (fetch it from `GET …/settings/logo`). */
  hasLogo!: boolean;
  /** ISO 8601 UTC instant of the last logo change. */
  logoUpdatedAt!: string | null;
  /** Send it back with every change: a stale value is rejected with 409 `VERSION_CONFLICT`. */
  version!: number;
}

/**
 * Changes to the settings. Omit a field to leave it unchanged; send `null` (or a blank string) to clear an
 * optional one. `displayName` needs the branding permission (Company Owner); everything else needs `company.edit`.
 */
export class UpdateSettingsDto {
  // required fields: a blank or null value is treated as "unchanged", never as "clear"
  @TrimText()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsIanaTimezone()
  timezone?: string;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(120)
  displayName?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(200)
  legalName?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(80)
  registrationNumber?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(120)
  sector?: string | null;

  /** Required: it can be changed but not cleared (a blank value is refused). */
  @TrimText()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  country?: string;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(500)
  address?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(120)
  dpoName?: string | null;

  /** Required: it can be changed but not cleared (a blank value is refused). */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  dpoEmail?: string;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(40)
  dpoPhone?: string | null;

  /** The `version` of the settings as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

export class RegulatorContactDto {
  id!: string;
  authorityName!: string;
  jurisdiction!: string | null;
  contactName!: string | null;
  email!: string | null;
  phone!: string | null;
  notes!: string | null;
  version!: number;
}

export class RegulatorContactPageDto {
  items!: RegulatorContactDto[];
  /** Pass as `after` to get the next page; null on the last page. */
  nextCursor!: string | null;
}

export class CreateRegulatorContactDto {
  /** The regulator or supervisory authority, as the organisation calls it. */
  @TrimText()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  authorityName!: string;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(120)
  jurisdiction?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(120)
  contactName?: string | null;

  @EmailToNull()
  @OptionalOrNull()
  @IsEmail()
  @MaxLength(254)
  email?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(40)
  phone?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

export class UpdateRegulatorContactDto {
  @TrimText()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  authorityName?: string;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(120)
  jurisdiction?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(120)
  contactName?: string | null;

  @EmailToNull()
  @OptionalOrNull()
  @IsEmail()
  @MaxLength(254)
  email?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(40)
  phone?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;

  /** The `version` of the contact as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

/** Multipart body of the logo upload (documentation only; the file is read by the upload interceptor). */
export class LogoUploadDto {
  /** A PNG or JPEG image up to 512 KiB. */
  @ApiProperty({ type: 'string', format: 'binary' })
  file!: unknown;
}
