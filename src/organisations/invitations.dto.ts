import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { ROLES, type Role } from '../permissions/catalogue.js';

/** `EXPIRED` is computed: a pending invitation past its expiry. It is never stored. */
export const INVITATION_STATES = ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'] as const;
export type InvitationState = (typeof INVITATION_STATES)[number];

const normaliseEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CreateInvitationDto {
  /** The address to invite. Stored lower-case. The person need not have an account yet. */
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  /** The role the person receives on accepting. Only a Company Owner may invite an Owner. */
  @ApiProperty({ enum: ROLES, enumName: 'Role' })
  @IsIn(ROLES)
  role!: Role;
}

export class InvitationDto {
  id!: string;
  email!: string;
  @ApiProperty({ enum: ROLES, enumName: 'Role' })
  role!: Role;
  @ApiProperty({ enum: INVITATION_STATES, enumName: 'InvitationState' })
  state!: InvitationState;
  /** ISO 8601 UTC instant. Renewed every time the email is (re)sent. */
  expiresAt!: string;
  /** How many times the invitation email was actually sent. */
  sendCount!: number;
  /** Display name of the member who invited. */
  invitedByName!: string;
  /** ISO 8601 UTC instant. */
  createdAt!: string;
  version!: number;
}

export class InvitationPageDto {
  items!: InvitationDto[];
  /** Pass as `after` to get the next page; null on the last page. */
  nextCursor!: string | null;
}

/** The one-time token from the invitation link (the part after `#token=`). */
export class InvitationTokenDto {
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token!: string;
}

/** What an invitation offers, shown before the invitee accepts. */
export class InvitationPreviewDto {
  organisationName!: string;
  @ApiProperty({ enum: ROLES, enumName: 'Role' })
  role!: Role;
  /** ISO 8601 UTC instant. */
  expiresAt!: string;
}

export class InvitationAcceptedDto {
  organisationId!: string;
  @ApiProperty({ enum: ROLES, enumName: 'Role' })
  role!: Role;
}
