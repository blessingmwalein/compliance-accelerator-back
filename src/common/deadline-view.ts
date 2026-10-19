import { ApiProperty } from '@nestjs/swagger';
import { DEADLINE_STATES, type DeadlineState } from '../domain/incidents/deadline.js';

/**
 * One due date as an API row shows it: its state, the day it was judged against, and the days between. The
 * incidents endpoints all answer with this shape — a request, a breach duty, a reminder — so one date cannot
 * be rendered three different ways, and `not_configured` means the same absent deadline everywhere.
 */
export class DeadlineViewDto {
  @ApiProperty({ enum: DEADLINE_STATES, enumName: 'DeadlineState' })
  state!: DeadlineState;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  dueOn!: string | null;

  /** Whole days from the organisation's today; negative once the day has passed. Null with no day. */
  // the decorator is not decoration: the Swagger CLI plugin only infers types in `*.dto.ts` files, and this
  // class lives in common/, so without it the field is sent but never appears in the published contract
  @ApiProperty({ type: Number, nullable: true })
  daysRemaining!: number | null;
}
