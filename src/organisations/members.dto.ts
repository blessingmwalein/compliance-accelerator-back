import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, Min } from 'class-validator';
import { ROLES, type Role } from '../permissions/catalogue.js';

export const MEMBER_STATUSES = ['ACTIVE', 'DEACTIVATED'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export class MemberDto {
  /** The membership id (use it in the member routes). */
  id!: string;
  userId!: string;
  email!: string;
  fullName!: string;
  @ApiProperty({ enum: ROLES, enumName: 'Role' })
  role!: Role;
  @ApiProperty({ enum: MEMBER_STATUSES, enumName: 'MemberStatus' })
  status!: MemberStatus;
  /** ISO 8601 UTC instant the person joined. */
  joinedAt!: string;
  /** Send it back unchanged with every change: a stale value is rejected with 409 `VERSION_CONFLICT`. */
  version!: number;
}

export class MemberPageDto {
  items!: MemberDto[];
  /** Pass as `after` to get the next page; null on the last page. */
  nextCursor!: string | null;
}

export class ChangeRoleDto {
  @ApiProperty({ enum: ROLES, enumName: 'Role' })
  @IsIn(ROLES)
  role!: Role;

  /** The `version` of the member as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

export class MemberVersionDto {
  /** The `version` of the member as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}
