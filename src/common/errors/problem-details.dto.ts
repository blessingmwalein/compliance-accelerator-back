/** One field-level problem inside a ProblemDetails response. */
export class FieldErrorDto {
  /** Dot-notation path of the offending field, e.g. `address.country`. */
  path!: string;

  /** Machine-readable rule code, e.g. `isEmail` or `maxLength`. */
  code!: string;

  /** Human-readable explanation. Safe to show but not stable: branch on `code`. */
  message?: string;
}

/** RFC 9457 `application/problem+json` body returned for every error response. */
export class ProblemDetailsDto {
  /** URI identifying the problem type (`urn:fca:problem:<code>`). */
  type!: string;

  /** Short, human-readable summary of the HTTP status. */
  title!: string;

  /** HTTP status code. */
  status!: number;

  /** Human-readable explanation specific to this occurrence. */
  detail?: string;

  /** Stable machine-readable error code. Clients branch on this. */
  code!: string;

  /** Field-level errors (validation failures). */
  errors?: FieldErrorDto[];

  /** Correlation id, also returned in the `X-Request-Id` response header. */
  requestId!: string;
}
