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
  /**
   * A feature that is planned but not built in this release. Distinct from `SERVICE_UNAVAILABLE`: the
   * server is healthy and retrying changes nothing, so a client must not queue the call again.
   */
  FeatureUnavailable: 'FEATURE_UNAVAILABLE',
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
  /** A multipart upload arrived with no file part, or with an empty one. */
  FileRequired: 'FILE_REQUIRED',
  /** The registers (Phase 6). */
  /** A live legal hold covers this record (or its retention rule): it cannot be disposed of or removed. */
  LegalHoldActive: 'LEGAL_HOLD_ACTIVE',
  /** A rule-wide disposal cannot be logged while any hold on that rule is live. */
  DisposalBlockedByHold: 'DISPOSAL_BLOCKED_BY_HOLD',
  /** The risk already has an acceptance in force: withdraw it first, then decide again. */
  RiskAcceptanceInForce: 'RISK_ACCEPTANCE_IN_FORCE',
  /** A closed or transferred risk cannot be accepted: acceptance is about risk still carried today. */
  RiskNotAcceptable: 'RISK_NOT_ACCEPTABLE',
  /** Another level (active or archived) already holds that rank: ranks are never reused. */
  ClassificationRankTaken: 'CLASSIFICATION_RANK_TAKEN',
  /** Another ACTIVE level already has that name. */
  ClassificationLevelNameTaken: 'CLASSIFICATION_LEVEL_NAME_TAKEN',
  /** Archiving would orphan records that still point at this one (activities, rules, evidence). */
  RecordInUse: 'RECORD_IN_USE',
  /**
   * The incident records (Phase 7). A request, a breach or a reminder that has been completed, refused,
   * withdrawn or closed: its chronology stays readable and its evidence stays linked, but no further
   * action is taken on it.
   */
  RecordAlreadyClosed: 'RECORD_ALREADY_CLOSED',
  /** The policy allows no more extensions for this request, or none at all (no window, no limit, no deadline). */
  ExtensionNotAllowed: 'EXTENSION_NOT_ALLOWED',
  /** A request cannot be completed while the requester's identity has not been verified (AC-DSAR-01). */
  IdentityNotVerified: 'IDENTITY_NOT_VERIFIED',
  /** A breach cannot be closed before its notification duty has been decided and recorded (AC-BRC-01). */
  BreachDecisionRequired: 'BREACH_DECISION_REQUIRED',
  /** `?version=n` named a version this item's ledger never had. */
  EvidenceVersionNotFound: 'EVIDENCE_VERSION_NOT_FOUND',
  /**
   * A CSV export would be larger than one file can carry (the audit trail is append-only and never pruned).
   * The answer is a narrower period, not a smaller row set, so the caller is told instead of truncated.
   */
  ExportRangeTooLarge: 'EXPORT_RANGE_TOO_LARGE',
  /**
   * A queued report ran out of attempts and nothing else explains it: the record carries the code, and the
   * document does not exist. Distinct from `EXPORT_RANGE_TOO_LARGE`, which is a request the caller can fix.
   */
  ReportGenerationFailed: 'REPORT_GENERATION_FAILED',
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
