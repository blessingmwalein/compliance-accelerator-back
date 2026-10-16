import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

const normaliseEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class RegisterDto {
  /** Email address. Stored lower-case. */
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  /** At least 12 characters, not a very common password, not containing the email name. */
  @IsString()
  @MaxLength(256)
  password!: string;

  /** Display name. */
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  fullName!: string;
}

export class LoginDto {
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MaxLength(256)
  password!: string;
}

/** Used by resend-verification and forgot-password. */
export class EmailOnlyDto {
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class VerifyEmailDto {
  /** The one-time token from the link in the email (the part after `#token=`). */
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token!: string;
}

export class ResetPasswordDto {
  /** The one-time token from the link in the email (the part after `#token=`). */
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token!: string;

  /** The new password (same rules as registration). */
  @IsString()
  @MaxLength(256)
  password!: string;
}

/** Returned with 202 by endpoints whose outcome must not reveal whether an address is registered. */
export class AcceptedDto {
  /** Always true: the request was accepted, whatever the state of the account. */
  accepted!: boolean;
}

export class AuthSessionDto {
  /** Short-lived access token. Keep it in memory; send it as `Authorization: Bearer`. */
  accessToken!: string;

  @ApiProperty({ enum: ['Bearer'] })
  tokenType!: 'Bearer';

  /** Seconds until the access token expires. */
  expiresInSeconds!: number;
}

export class MeDto {
  id!: string;
  email!: string;
  fullName!: string;
  /** False until the address was confirmed; unverified accounts cannot sign in. */
  emailVerified!: boolean;
  /** True for a platform administrator (may use `/platform/*`; that alone gives no access to any organisation's data). */
  isPlatformAdmin!: boolean;
  /** ISO 8601 UTC instant. */
  createdAt!: string;
}
