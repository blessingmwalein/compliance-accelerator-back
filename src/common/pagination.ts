import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

/**
 * Cursor (keyset) pagination for every list endpoint: no OFFSET, a hard cap, and a cursor that is
 * simply the id of the last row seen (ids are UUIDv7, so id order is creation order).
 */
export class PageQueryDto {
  /** Page size (1 to 100, default 50). */
  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  /** The `nextCursor` of the previous page. Omit for the first page. */
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  after?: string;
}

/** Fetch `limit + 1` rows, then call this: the extra row only proves there is another page. */
export function toPage<T extends { id: string }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last ? last.id : null };
}

export const pageSizeOf = (query: PageQueryDto): number => query.limit ?? DEFAULT_PAGE_SIZE;
