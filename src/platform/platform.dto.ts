import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { IsIanaTimezone } from '../common/validators/is-iana-timezone.js';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const normaliseEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class ProvisionOrganisationDto {
  /** The organisation's name (2 to 120 characters). */
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  /** IANA time zone (for example `Africa/Harare`). */
  @IsIanaTimezone()
  timezone!: string;

  /** The address that is invited as the organisation's first Company Owner. */
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  ownerEmail!: string;

  /** Optionally assign a plan right away (see `GET /platform/plans`). Without one, no limits are enforced. */
  @IsOptional()
  @IsUUID()
  planId?: string;
}

export class ProvisionedOrganisationDto {
  id!: string;
  name!: string;
  timezone!: string;
  /** The address that received the Owner invitation. */
  ownerEmail!: string;
}

export class PlatformOrganisationDto {
  id!: string;
  name!: string;
  timezone!: string;
  /** ISO 8601 UTC instant. */
  createdAt!: string;
  memberCount!: number;
  ownerCount!: number;
  pendingInvitations!: number;
  /** The plan assigned to the organisation, if any. */
  planName!: string | null;
}

export class PlatformOrganisationPageDto {
  items!: PlatformOrganisationDto[];
  /** Pass as `after` to get the next page; null on the last page. */
  nextCursor!: string | null;
}
