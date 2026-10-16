/** True when a database error is a unique-constraint violation (Prisma code P2002), including partial unique indexes. */
export const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === 'P2002';
