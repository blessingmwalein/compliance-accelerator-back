import type { Band, Methodology } from '../domain/scoring/methodologies.js';
import { EXPOSURE_V1 } from '../domain/scoring/methodologies.js';

/** The methodologies this build knows. A stored snapshot names one by id, so a row stays readable forever. */
const KNOWN: ReadonlyMap<string, Methodology> = new Map([[EXPOSURE_V1.id, EXPOSURE_V1]]);

export const methodologyOf = (id: string): Methodology | undefined => KNOWN.get(id);

/**
 * The exposure bands an assessment was created with, read back from its JSON snapshot. Every write goes
 * through `ScoringService`, which stores exactly four `{ key, label, min, max }` objects, so this only has to
 * keep Prisma's `JsonValue` away from the domain types.
 */
export const bandsOf = (snapshot: unknown): Band[] => snapshot as Band[];

/** A stored `@db.Date` as the contract's `YYYY-MM-DD` (never an instant). */
export const dateOnlyOf = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);

/** A contract `YYYY-MM-DD` as the date value Prisma stores in a `@db.Date` column. */
export const dateOnlyToValue = (value: string | null | undefined): Date | null =>
  value === undefined || value === null ? null : new Date(`${value}T00:00:00.000Z`);
