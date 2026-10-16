import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsIanaTimezone } from '../common/validators/is-iana-timezone.js';
import { PERMISSIONS, ROLES, type Permission, type Role } from '../permissions/catalogue.js';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateOrganisationDto {
  /** The organisation's name (2 to 120 characters). */
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  /** IANA time zone (for example `Africa/Harare`). Deadlines and reminders are computed in this zone. */
  @IsIanaTimezone()
  timezone!: string;
}

export class OrganisationBriefDto {
  id!: string;
  name!: string;
  /** IANA time zone. */
  timezone!: string;
}

/** One organisation the caller belongs to, with their role in it. */
export class OrganisationSummaryDto extends OrganisationBriefDto {
  @ApiProperty({ enum: ROLES, enumName: 'Role' })
  role!: Role;
}

/** The caller's own membership in the organisation of the path. */
export class MyMembershipDto {
  organisation!: OrganisationBriefDto;
  membershipId!: string;
  @ApiProperty({ enum: ROLES, enumName: 'Role' })
  role!: Role;
  /** Everything the role may do (the permission catalogue). The UI uses it to show or hide actions; the API enforces it regardless. */
  @ApiProperty({ type: [String], enum: PERMISSIONS, enumName: 'Permission' })
  permissions!: Permission[];
}
