import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

/** A framework in the catalogue. Identifiers only: the catalogue holds no legal text. */
export class FrameworkDto {
  id!: string;
  /** Short code shown in the UI (for example `GDPR`). */
  code!: string;
  name!: string;
  jurisdiction!: string;
  /** `LAW`, `STANDARD` or `FRAMEWORK`: how the source is described, not a claim about its legal force. */
  kind!: string;
}

/** One catalogue framework, with whether this organisation declared it applicable. */
export class OrganisationFrameworkDto extends FrameworkDto {
  /** True while the organisation has it in its applicable set. */
  applicable!: boolean;
  /** ISO 8601 UTC instant it was (first) declared applicable, if ever. */
  addedAt!: string | null;
  /** ISO 8601 UTC instant it was removed from the set, if it was. The history is kept. */
  removedAt!: string | null;
}

export class SetFrameworksDto {
  /** The ids of every framework that should be applicable (the full desired set). Others are removed from it. */
  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  frameworkIds!: string[];
}
