import { HttpException, HttpStatus } from '@nestjs/common';

/** One field-level problem, e.g. a failed validation rule. `path` uses dot notation. */
export interface FieldError {
  path: string;
  code: string;
  message?: string;
}

/**
 * Stable, machine-readable error codes. The frontend branches on these; never on `detail`.
 * Add new codes here (and to the contract changelog) rather than inventing them inline.
 */
export const ErrorCode = {
  BadRequest: 'BAD_REQUEST',
  ValidationFailed: 'VALIDATION_FAILED',
  Unauthenticated: 'UNAUTHENTICATED',
  Forbidden: 'FORBIDDEN',
  NotFound: 'NOT_FOUND',
  Conflict: 'CONFLICT',
  PayloadTooLarge: 'PAYLOAD_TOO_LARGE',
  UnsupportedMediaType: 'UNSUPPORTED_MEDIA_TYPE',
  RateLimited: 'RATE_LIMITED',
  InternalError: 'INTERNAL_ERROR',
  ServiceUnavailable: 'SERVICE_UNAVAILABLE',
  DatabaseNotConfigured: 'DATABASE_NOT_CONFIGURED',
  DatabaseUnavailable: 'DATABASE_UNAVAILABLE',
  InvalidCredentials: 'INVALID_CREDENTIALS',
  EmailNotVerified: 'EMAIL_NOT_VERIFIED',
  InvalidToken: 'INVALID_TOKEN',
  /** The change would leave an organisation without an active Company Owner (AC-USR-04). */
  LastOwner: 'LAST_OWNER',
  AlreadyMember: 'ALREADY_MEMBER',
  InvitationPending: 'INVITATION_PENDING',
  /** The invitation was sent to another address than the signed-in account's. */
  InvitationEmailMismatch: 'INVITATION_EMAIL_MISMATCH',
  /** Optimistic locking: the record changed since the client read it (`version` differs). */
  VersionConflict: 'VERSION_CONFLICT',
  /** Granting, changing or removing the Owner role needs an Owner. */
  OwnerOnly: 'OWNER_ONLY',
  /** Nobody changes their own role or deactivates themselves. */
  SelfChangeNotAllowed: 'SELF_CHANGE_NOT_ALLOWED',
  /** `ORGANISATIONS_SELF_SERVE` is off: organisations are provisioned by a platform administrator. */
  SelfServeDisabled: 'SELF_SERVE_DISABLED',
  BusinessUnitNameTaken: 'BUSINESS_UNIT_NAME_TAKEN',
  BusinessUnitCodeTaken: 'BUSINESS_UNIT_CODE_TAKEN',
  BusinessUnitHasChildren: 'BUSINESS_UNIT_HAS_CHILDREN',
  /** The organisation's plan allows no more users (active members plus pending invitations). */
  UserLimitReached: 'USER_LIMIT_REACHED',
  GovernanceAreaNameTaken: 'GOVERNANCE_AREA_NAME_TAKEN',
  /** The same two requirements are already mapped (in either direction) by an active mapping. */
  MappingAlreadyExists: 'MAPPING_ALREADY_EXISTS',
  /** Load Default Mappings found no VERIFIED mapping pack for the organisation's frameworks: nothing was written. */
  SeedDataUnavailable: 'SEED_DATA_UNAVAILABLE',
  /** Load Default Mappings needs at least one applicable framework (Company Settings). */
  NoFrameworksSelected: 'NO_FRAMEWORKS_SELECTED',
  /** The assessment is not a DRAFT (in review, approved or superseded): its content cannot change. */
  AssessmentNotEditable: 'ASSESSMENT_NOT_EDITABLE',
  /** An assessment with no items cannot be submitted for review. */
  AssessmentEmpty: 'ASSESSMENT_EMPTY',
  /** The same subject (area, requirement, business unit, framework) is already in this assessment. */
  AssessmentItemExists: 'ASSESSMENT_ITEM_EXISTS',
  /** The status change is not allowed from the task's current status. */
  InvalidTransition: 'INVALID_TRANSITION',
  /** Only the assignee or someone who may edit remediation work can change this task. */
  NotAssignee: 'NOT_ASSIGNEE',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Domain/application error that renders as RFC 9457 problem+json with a stable `code`. */
export class AppException extends HttpException {
  constructor(
    readonly code: ErrorCodeValue | (string & {}),
    status: HttpStatus,
    readonly detail?: string,
    readonly errors?: FieldError[],
    /** Extra response headers, e.g. `Retry-After` on a lockout. */
    readonly headers?: Readonly<Record<string, string>>,
  ) {
    super({ code, detail, errors }, status);
  }
}
