import { TextDecoder } from 'node:util';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { AppException, ErrorCode, type FieldError } from '../common/errors/app.exception.js';
import { isUniqueViolation } from '../common/errors/unique-violation.js';
import { pageSizeOf, toPage } from '../common/pagination.js';
import { uuidv7 } from '../common/uuid.js';
import type { EnvironmentVariables } from '../config/env.schema.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { todayIn } from '../domain/remediation/policy.js';
import { toDateOnly, utcDay } from '../domain/registers/review.js';
import {
  findEvidenceReviewTransition,
  isReviewOutcome,
  isScanAttested,
  nextEvidenceReviewStatuses,
  scanNoteRequired,
  type EvidenceReviewStatus,
  type EvidenceReviewTransition,
  type EvidenceScanState,
} from '../domain/incidents/evidence.js';
import { roleHas, type Permission } from '../permissions/catalogue.js';
import { StorageProvider } from '../storage/storage-provider.js';
import { RequestContext } from '../tenancy/request-context.js';
import type {
  AttestEvidenceScanDto,
  ChangeEvidenceReviewDto,
  EvidenceDetailDto,
  EvidenceDto,
  EvidenceListQueryDto,
  EvidencePageDto,
  EvidenceReviewTransitionDto,
  EvidenceVersionDto,
  EvidenceVersionListDto,
  UpdateEvidenceDto,
  UploadEvidenceDto,
  UploadEvidenceVersionDto,
} from './evidence.dto.js';
import {
  EvidenceRepository,
  type EvidenceCreateFields,
  type EvidenceDetailRecord,
  type EvidenceMetadataChanges,
  type EvidenceRecord,
  type EvidenceVersionRecord,
} from './evidence.repository.js';

/** The cap in the words an uploader reads: whole MiB when it is one, bytes when it is not. */
const humanBytes = (bytes: number): string =>
  bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${bytes} bytes`;

/**
 * What evidence may be: the two documents people are asked for (PDF, plain text/CSV) and the three
 * raster image formats. Anything else is refused — never SVG or HTML (they can carry script), never an
 * executable, never an archive or container (zip, gzip, 7z and the OOXML formats, which ARE zip
 * containers: that is why a .docx or .xlsx is not accepted).
 */
export const EVIDENCE_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'text/plain',
  'text/csv',
] as const;

export type EvidenceContentType = (typeof EVIDENCE_CONTENT_TYPES)[number];

/** The shortest reason or note the database accepts (`length(btrim(...)) >= 3` in `evidence_check`). */
const MIN_NOTE = 3;

const startsWith = (data: Buffer, signature: readonly number[]): boolean =>
  data.length >= signature.length && signature.every((byte, index) => data[index] === byte);

const PDF = [0x25, 0x50, 0x44, 0x46]; // %PDF
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF_87A = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]; // GIF87a
const GIF_89A = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]; // GIF89a
const UTF8_BOM = [0xef, 0xbb, 0xbf];

/** Text may contain tab, newline and carriage return, and no other byte below the space (nor DEL). */
const hasBinaryBytes = (data: Buffer): boolean =>
  data.some(
    (byte) => (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f,
  );

const isUtf8 = (data: Buffer): boolean => {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
};

/** The first byte that is neither a UTF-8 byte-order mark nor leading whitespace. */
function firstSignificantByte(data: Buffer): number | undefined {
  let index = startsWith(data, UTF8_BOM) ? UTF8_BOM.length : 0;
  while (
    index < data.length &&
    (data[index] === 0x20 || data[index] === 0x09 || data[index] === 0x0a || data[index] === 0x0d)
  ) {
    index += 1;
  }
  return data[index];
}

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
};

/**
 * The type of the file, decided from its BYTES. The caller's `Content-Type` and the file name are never
 * trusted: only the label for text/plain versus text/csv comes from the name, and only after the bytes
 * have already proved they are text. Markup (`<` as the first real character) is refused even though it
 * would decode as UTF-8: that is how HTML and SVG are turned away, whatever their extension claims.
 */
function sniffContentType(data: Buffer, filename: string): EvidenceContentType | null {
  if (startsWith(data, PDF)) return 'application/pdf';
  if (startsWith(data, PNG)) return 'image/png';
  if (startsWith(data, JPEG)) return 'image/jpeg';
  if (startsWith(data, GIF_87A) || startsWith(data, GIF_89A)) return 'image/gif';
  if (firstSignificantByte(data) === 0x3c) return null; // '<': HTML, XML or SVG
  if (!isUtf8(data) || hasBinaryBytes(data)) return null; // binary, or an archive whose bytes are not text
  return extensionOf(filename) === '.csv' ? 'text/csv' : 'text/plain';
}

/** Kept short so a display name and a download header stay sane; the version row caps it at 255. */
const MAX_FILENAME_LENGTH = 180;

/**
 * The uploader's file name, made fit to store and show: any directory part is dropped (a browser sends a
 * fake `C:\path\`, an attacker a real one), control characters are stripped, the rest is trimmed and
 * capped. It is a label in a database column: it is never used to build a path, a key or a URL.
 */
export function sanitiseFilename(raw: string | undefined): string {
  const base = (raw ?? '').split(/[/\\]/).pop() ?? '';
  let cleaned = '';
  for (const character of base) {
    const code = character.codePointAt(0) ?? 0;
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f); // C0, DEL and C1
    if (!isControl) cleaned += character;
  }
  cleaned = cleaned.trim().slice(0, MAX_FILENAME_LENGTH);
  return cleaned.length === 0 || /^\.+$/.test(cleaned) ? 'evidence' : cleaned;
}

/**
 * The file fields shown for a record, read from its CURRENT version (the columns no longer live on the
 * evidence row). `current` is never null in practice — every record is written with version 1 and the
 * migration copied the Phase 5 files into it — so the fallbacks are unreachable, never a guessed 0.
 */
const fileFieldsOf = (record: EvidenceRecord) => ({
  id: record.id,
  title: record.title,
  description: record.description,
  originalFilename: record.current?.originalFilename ?? '',
  contentType: record.current?.contentType ?? '',
  size: record.current?.size ?? 0,
  sha256: record.current?.sha256 ?? '',
  uploadedByUserId: record.uploadedByUserId,
  currentVersion: record.currentVersion,
  ownerMembershipId: record.ownerMembershipId,
  reviewStatus: record.reviewStatus,
  reviewedByUserId: record.reviewedByUserId,
  scanState: record.scanState,
  scannedOn: toDateOnly(record.scannedOn),
  attestedByUserId: record.attestedByUserId,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
  version: record.version,
});

const toDto = (record: EvidenceRecord): EvidenceDto => fileFieldsOf(record);

const toVersionDto = (
  version: EvidenceVersionRecord,
  currentVersion: number,
  scanState: EvidenceScanState,
): EvidenceVersionDto => ({
  number: version.number,
  originalFilename: version.originalFilename,
  contentType: version.contentType,
  size: version.size,
  sha256: version.sha256,
  uploadedByUserId: version.uploadedByUserId,
  createdAt: version.createdAt.toISOString(),
  // an attestation covers only the bytes it named: a superseded version is not scanned
  scanState: version.number === currentVersion ? scanState : 'NOT_SCANNED',
  isCurrent: version.number === currentVersion,
});

const notFound = () =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Evidence not found.');

const versionNotFound = (version: number) =>
  new AppException(
    ErrorCode.EvidenceVersionNotFound,
    HttpStatus.NOT_FOUND,
    `This evidence record has no version ${version}.`,
  );

const versionConflict = () =>
  new AppException(
    ErrorCode.VersionConflict,
    HttpStatus.CONFLICT,
    'This evidence record was changed by someone else. Reload and try again.',
  );

const forbidden = (what: string) =>
  new AppException(ErrorCode.Forbidden, HttpStatus.FORBIDDEN, `Only an approver can ${what}.`);

const invalidTransition = (from: EvidenceReviewStatus, allowed: readonly EvidenceReviewStatus[]) =>
  new AppException(
    ErrorCode.InvalidTransition,
    HttpStatus.CONFLICT,
    allowed.length === 0
      ? `Evidence that is ${from} cannot move.`
      : `Evidence that is ${from} can only become ${allowed.join(', ')}.`,
    [{ path: 'toStatus', code: 'invalidTransition', message: `Allowed: ${allowed.join(', ')}.` }],
  );

/** A missing or empty file is a form problem, so it answers with the validation shape (400). */
const fieldProblem = (path: string, code: string, message: string): AppException => {
  const errors: FieldError[] = [{ path, code, message }];
  return new AppException(
    ErrorCode.ValidationFailed,
    HttpStatus.BAD_REQUEST,
    'Request validation failed.',
    errors,
  );
};

const missingFile = () =>
  fieldProblem('file', 'isNotEmpty', 'Choose a file to upload: it cannot be empty.');

const titleRequired = () =>
  fieldProblem('title', 'isString', 'A title is required: it cannot be cleared.');

const invalid = (path: string, code: string, message: string) => fieldProblem(path, code, message);

/** A file that exists in the database but not in storage: say so plainly, and never leak where it was kept. */
const bytesMissing = () =>
  new AppException(
    ErrorCode.NotFound,
    HttpStatus.NOT_FOUND,
    'The stored file of this evidence record is missing, so it cannot be downloaded. Upload it again.',
  );

export interface EvidenceDownload {
  data: Buffer;
  contentType: string;
  /** The server-computed checksum, used as the `ETag` of the response. */
  sha256: string;
  filename: string;
}

/** The caller's role, as the one rule this service needs to decide a per-row review step. */
interface Caller {
  may: (permission: Permission) => boolean;
}

/**
 * The evidence repository (Phases 5 and 7): upload, versions, owner, review lifecycle, scan attestation,
 * list/detail and download.
 *
 * A record keeps the description of a file; the file itself lives in private storage under an opaque key
 * per version (`org/<organisation>/evidence/<evidence>/<number>`) and is only ever served through the
 * authorised download endpoint. Every claim about the file — its type, size, checksum, name — is measured
 * here on the server. Nothing is deleted: a superseded version stays, a rejected item stays, and review
 * moves through states.
 */
@Injectable()
export class EvidenceService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly evidence: EvidenceRepository,
    private readonly audit: AuditService,
    private readonly storage: StorageProvider,
    private readonly requestContext: RequestContext,
    private readonly clock: Clock,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  /**
   * The largest evidence file this deployment accepts (`EVIDENCE_MAX_BYTES`). It is configuration, not a
   * constant, because the host decides it: a serverless function refuses a body over 4.5 MB before any
   * application code runs, so a cap above that would be a limit the uploader is never told about. The API
   * states it on `GET /api/v1/meta`, which is where a client reads it from.
   */
  private get maxEvidenceBytes(): number {
    return this.config.get('EVIDENCE_MAX_BYTES', { infer: true });
  }

  async list(query: EvidenceListQueryDto): Promise<EvidencePageDto> {
    const limit = pageSizeOf(query);
    const rows = await this.uow.run((tx) =>
      this.evidence.list(tx, {
        limit,
        ...(query.after ? { after: query.after } : {}),
        ...(query.q ? { q: query.q } : {}),
        ...(query.reviewStatus ? { reviewStatus: query.reviewStatus } : {}),
        ...(query.scanState ? { scanState: query.scanState } : {}),
        ...(query.ownerMembershipId ? { ownerMembershipId: query.ownerMembershipId } : {}),
      }),
    );
    const page = toPage(rows, limit);
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }

  async get(id: string): Promise<EvidenceDetailDto> {
    const record = await this.uow.run((tx) => this.evidence.findDetail(tx, id));
    if (!record) throw notFound();
    return this.toDetailDto(record);
  }

  /**
   * Stores the first file of a new record: the bytes first, then the row and its version 1 and audit
   * event in one transaction.
   *
   * The order is deliberate. A row is never written before its bytes exist, so a download can only fail
   * because somebody deleted an object behind our back, never because we recorded a file we did not
   * store. When the transaction fails we try to remove the file we just wrote; if that cleanup itself
   * fails, an orphan stays in storage — unreferenced, unlistable and unservable, which is harmless
   * compared with the reverse.
   */
  async upload(
    dto: UploadEvidenceDto,
    bytes: Buffer | undefined,
    originalFilename: string | undefined,
  ): Promise<EvidenceDto> {
    const organisationId = this.requestContext.requireOrganisationId();
    const actorUserId = this.actorUserId();

    const inspected = this.inspect(bytes, originalFilename);
    const id = uuidv7();
    const storageKey = `org/${organisationId}/evidence/${id}/1`;
    const stored = await this.storage.put(storageKey, inspected.bytes);

    let record: EvidenceRecord;
    try {
      record = await this.uow.run(async (tx) => {
        const fields: EvidenceCreateFields = {
          id,
          title: dto.title,
          description: dto.description ?? null,
          uploadedByUserId: actorUserId,
          originalFilename: inspected.filename,
          contentType: inspected.contentType,
          size: stored.size,
          sha256: stored.sha256,
          storageKey,
        };
        const created = await this.evidence.create(tx, fields);
        // Personal-data minimisation: the trail records the fact and the technical shape of the file —
        // never its contents, never a path or storage key, and not even its name (which can be personal).
        await this.audit.record(tx, {
          action: 'evidence.uploaded',
          entityType: 'evidence',
          entityId: created.id,
          entityLabel: created.title,
          changes: { contentType: created.current?.contentType, size: created.current?.size },
        });
        return created;
      });
    } catch (error) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
    return toDto(record);
  }

  /**
   * Stores a new version of an existing record. The number is the current maximum plus one, the bytes
   * are stored first, then the version row and the moved pointer live in one transaction.
   *
   * A new version is new bytes, so the attestation that covered the old file cannot carry over: the
   * database's version guard refuses an update that moves `current_version` while the scan state is not
   * back to NOT_SCANNED, and the review loses the judgement made about the superseded file.
   */
  async uploadVersion(
    id: string,
    dto: UploadEvidenceVersionDto,
    bytes: Buffer | undefined,
    originalFilename: string | undefined,
  ): Promise<EvidenceDto> {
    const organisationId = this.requestContext.requireOrganisationId();
    const actorUserId = this.actorUserId();

    const inspected = this.inspect(bytes, originalFilename);

    // Read the current version once to name the new one. The key carries a fresh id as well, because the
    // number is guessed before the write: two uploads that read the same head would otherwise store over
    // each other's bytes and the loser's cleanup would delete the winner's file.
    const head = await this.uow.run((tx) => this.evidence.findById(tx, id));
    if (!head) throw notFound();
    const number = head.currentVersion + 1;
    const storageKey = `org/${organisationId}/evidence/${id}/${number}/${uuidv7()}`;
    const stored = await this.storage.put(storageKey, inspected.bytes);

    let record: EvidenceRecord;
    try {
      record = await this.uow.run(async (tx) => {
        const current = await this.evidence.findById(tx, id);
        if (!current) throw notFound();
        await this.evidence.createVersion(tx, {
          evidenceId: id,
          number,
          originalFilename: inspected.filename,
          contentType: inspected.contentType,
          size: stored.size,
          sha256: stored.sha256,
          storageKey,
          note: dto.note ?? null,
          uploadedByUserId: actorUserId,
        });
        // guarded by the row's version, so a second concurrent upload cannot silently win the pointer
        if (!(await this.evidence.supersede(tx, id, current.version, number))) {
          throw versionConflict();
        }
        await this.audit.record(tx, {
          action: 'evidence.version_uploaded',
          entityType: 'evidence',
          entityId: id,
          entityLabel: current.title,
          changes: { version: number, contentType: inspected.contentType, size: stored.size },
        });
        const fresh = await this.evidence.findById(tx, id);
        if (!fresh) throw notFound();
        return fresh;
      });
    } catch (error) {
      await this.storage.delete(storageKey).catch(() => undefined);
      // two uploads that read the same head both name number+1: the version index is what separates them,
      // so the loser is told to reload rather than handed a database error
      if (isUniqueViolation(error)) throw versionConflict();
      throw error;
    }
    return toDto(record);
  }

  /** The version ledger of one record, newest number last. Short, so never paginated, never the key. */
  listVersions(id: string): Promise<EvidenceVersionListDto> {
    return this.uow.run(async (tx) => {
      const record = await this.evidence.findById(tx, id);
      if (!record) throw notFound();
      const versions = await this.evidence.listVersions(tx, id);
      return {
        items: versions.map((version) =>
          toVersionDto(version, record.currentVersion, record.scanState),
        ),
      };
    });
  }

  /**
   * Metadata and ownership only (title, description, owner); `version` guards the write. The file cannot
   * be replaced here: that is a new version. An owner must be an active member of this organisation.
   */
  async update(id: string, dto: UpdateEvidenceDto): Promise<EvidenceDto> {
    return this.uow.run(async (tx) => {
      const current = await this.evidence.findById(tx, id);
      if (!current) throw notFound();
      if (current.version !== dto.version) throw versionConflict();
      if (dto.title === null) throw titleRequired();

      const changes: EvidenceMetadataChanges = {};
      if (dto.title !== undefined && dto.title !== current.title) changes.title = dto.title;
      if (dto.description !== undefined && dto.description !== current.description) {
        changes.description = dto.description;
      }
      if (
        dto.ownerMembershipId !== undefined &&
        dto.ownerMembershipId !== current.ownerMembershipId
      ) {
        if (
          dto.ownerMembershipId !== null &&
          !(await this.evidence.findActiveMember(tx, dto.ownerMembershipId))
        ) {
          throw invalid(
            'ownerMembershipId',
            'notAnActiveMember',
            'The owner must be an active member of this organisation.',
          );
        }
        changes.ownerMembershipId = dto.ownerMembershipId;
      }
      if (Object.keys(changes).length === 0) return toDto(current);

      if (!(await this.evidence.update(tx, id, dto.version, changes))) throw versionConflict();
      const updated = await this.evidence.findById(tx, id);
      await this.audit.record(tx, {
        action: 'evidence.updated',
        entityType: 'evidence',
        entityId: id,
        entityLabel: updated?.title ?? current.title,
        // which fields moved, never their free text (a description can carry personal data)
        changes: Object.fromEntries(Object.keys(changes).map((field) => [field, 'changed'])),
      });
      return updated ? toDto(updated) : toDto(current);
    });
  }

  /**
   * One step along the review lifecycle. The permission depends on the step, so the route is open to any
   * active member and this service decides: `approve` steps need `governance.approve`, `work` steps need
   * `governance.edit`. An outcome records its author (the row's CHECK pairs the two), and every step the
   * table marks `needsReason` arrives with a reason at least as long as the database accepts.
   */
  async changeReview(id: string, dto: ChangeEvidenceReviewDto): Promise<EvidenceDetailDto> {
    return this.uow.run(async (tx) => {
      const current = await this.evidence.findById(tx, id);
      if (!current) throw notFound();
      if (current.version !== dto.version) throw versionConflict();

      const from = current.reviewStatus;
      const to = dto.toStatus;
      if (to === from) throw invalid('toStatus', 'unchanged', `This evidence is already ${to}.`);

      const transition = findEvidenceReviewTransition(from, to);
      if (!transition) {
        throw invalidTransition(
          from,
          nextEvidenceReviewStatuses(from).map((step) => step.to),
        );
      }
      this.assertMayTake(transition);

      const note = dto.note?.trim() ?? '';
      if (transition.needsReason && note.length < MIN_NOTE) {
        throw invalid(
          'note',
          'reasonRequired',
          `Moving evidence from ${transition.from} to ${transition.to} needs a reason of at least ${MIN_NOTE} characters.`,
        );
      }

      const outcome = isReviewOutcome(to);
      if (
        !(await this.evidence.changeReview(tx, id, dto.version, {
          reviewStatus: to,
          // the CHECK pairs an outcome with a named reviewer and forbids a reviewer on an open state
          reviewedByUserId: outcome ? this.actorUserId() : null,
          reviewNote: note === '' ? null : note,
        }))
      ) {
        throw versionConflict();
      }
      await this.audit.record(tx, {
        action: 'evidence.review_changed',
        entityType: 'evidence',
        entityId: id,
        entityLabel: current.title,
        changes: {
          reviewStatus: { from: transition.from, to: transition.to },
          ...(note === '' ? {} : { note }),
        },
      });
      const fresh = await this.evidence.findDetail(tx, id);
      if (!fresh) throw notFound();
      return this.toDetailDto(fresh);
    });
  }

  /**
   * Attest the scan result of the CURRENT version: a dated statement by the caller, never `NOT_SCANNED`
   * (that is the absence of an attestation, not a claim), and always explained for a bad result. The row
   * pairs a scanned state with a date and an author, so this writes all three together.
   */
  async attestScan(id: string, dto: AttestEvidenceScanDto): Promise<EvidenceDetailDto> {
    return this.uow.run(async (tx) => {
      const current = await this.evidence.findById(tx, id);
      if (!current) throw notFound();
      if (current.version !== dto.version) throw versionConflict();

      const state = dto.scanState;
      if (!isScanAttested(state)) {
        throw invalid(
          'scanState',
          'notAnAttestation',
          'A scan attestation cannot be NOT_SCANNED: record a real result, or upload a new version to clear it.',
        );
      }
      const note = dto.note?.trim() ?? '';
      if (scanNoteRequired(state) && note.length < MIN_NOTE) {
        throw invalid(
          'note',
          'noteRequired',
          `${state} needs a note of at least ${MIN_NOTE} characters: say what the scan found.`,
        );
      }

      // the day the attester stood behind, in the organisation's own zone: the same rule every other
      // dated statement in this phase uses, so a check made late in a working day is not dated tomorrow
      const scannedOn = utcDay(todayIn(await this.evidence.timezone(tx), this.clock.now()));
      if (
        !(await this.evidence.attestScan(tx, id, dto.version, {
          scanState: state,
          scannedOn,
          scanNote: note === '' ? null : note,
          attestedByUserId: this.actorUserId(),
        }))
      ) {
        throw versionConflict();
      }
      await this.audit.record(tx, {
        action: 'evidence.scan_attested',
        entityType: 'evidence',
        entityId: id,
        entityLabel: current.title,
        changes: {
          scanState: state,
          version: current.currentVersion,
          ...(note === '' ? {} : { note }),
        },
      });
      const fresh = await this.evidence.findDetail(tx, id);
      if (!fresh) throw notFound();
      return this.toDetailDto(fresh);
    });
  }

  /**
   * The bytes of a stored file, for an authorised caller. Without `version` the current one is served; a
   * named version that this record never had answers `EVIDENCE_VERSION_NOT_FOUND`. The access check is
   * done before anything is read and the download is audited in the same transaction as the lookup.
   */
  async download(id: string, version?: number): Promise<EvidenceDownload> {
    const target = await this.uow.run(async (tx) => {
      const found = await this.evidence.findById(tx, id);
      if (!found) throw notFound();
      const chosen =
        version === undefined ? found.current : await this.evidence.findVersion(tx, id, version);
      if (!chosen) throw versionNotFound(version as number);
      await this.audit.record(tx, {
        action: 'evidence.downloaded',
        entityType: 'evidence',
        entityId: found.id,
        entityLabel: found.title,
        changes: { version: chosen.number },
      });
      return chosen;
    });
    // Outside the transaction: a storage read is not database work, and the Neon pooler wants short ones.
    const data = await this.storage.get(target.storageKey);
    if (!data) throw bytesMissing();
    return {
      data,
      contentType: target.contentType,
      sha256: target.sha256,
      filename: target.originalFilename,
    };
  }

  // ---- the checks, all of them here and none of them in the controller

  /** Size and type of an incoming file, decided from the bytes before anything is stored. */
  private inspect(
    raw: Buffer | undefined,
    originalFilename: string | undefined,
  ): { bytes: Buffer; filename: string; contentType: EvidenceContentType } {
    if (!raw || raw.length === 0) throw missingFile();
    // The interceptor bounds the body at the pipeline's memory ceiling; this is the deployment's own cap.
    const maxBytes = this.maxEvidenceBytes;
    if (raw.length > maxBytes) {
      throw new AppException(
        ErrorCode.PayloadTooLarge,
        HttpStatus.PAYLOAD_TOO_LARGE,
        `An evidence file must be ${humanBytes(maxBytes)} or smaller.`,
      );
    }
    const filename = sanitiseFilename(originalFilename);
    const contentType = sniffContentType(raw, filename);
    if (!contentType) {
      throw new AppException(
        ErrorCode.UnsupportedMediaType,
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        'Evidence must be a PDF, PNG, JPEG, GIF, plain text or CSV file.',
      );
    }
    return { bytes: raw, filename, contentType };
  }

  private caller(): Caller {
    const { role } = this.requestContext.get();
    return { may: (permission) => role !== undefined && roleHas(role, permission) };
  }

  private assertMayTake(transition: EvidenceReviewTransition): void {
    if (transition.by === 'approve') {
      if (!this.caller().may('governance.approve')) {
        throw forbidden(`move evidence from ${transition.from} to ${transition.to}`);
      }
      return;
    }
    if (!this.caller().may('governance.edit')) {
      throw new AppException(
        ErrorCode.Forbidden,
        HttpStatus.FORBIDDEN,
        'Only someone who may edit the evidence repository can take this step.',
      );
    }
  }

  /** The review moves THIS caller can take now, so the UI never offers a forbidden one. */
  private allowedTransitions(status: EvidenceReviewStatus): EvidenceReviewTransitionDto[] {
    const caller = this.caller();
    return nextEvidenceReviewStatuses(status)
      .filter((step) =>
        step.by === 'approve' ? caller.may('governance.approve') : caller.may('governance.edit'),
      )
      .map(({ to, by, needsReason }) => ({ toStatus: to, by, needsReason }));
  }

  private toDetailDto(record: EvidenceDetailRecord): EvidenceDetailDto {
    return {
      ...fileFieldsOf(record),
      reviewNote: record.reviewNote,
      lastReviewDate: toDateOnly(record.lastReviewDate),
      nextReviewDate: toDateOnly(record.nextReviewDate),
      scanNote: record.scanNote,
      linkedItemIds: record.linkedItemIds,
      linkedTaskIds: record.linkedTaskIds,
      allowedTransitions: this.allowedTransitions(record.reviewStatus),
    };
  }

  /** The person a decision is attributed to; a review and a scan are always attributed. */
  private actorUserId(): string {
    const actorUserId = this.requestContext.actorUserId;
    if (!actorUserId) {
      throw new AppException(
        ErrorCode.InternalError,
        HttpStatus.INTERNAL_SERVER_ERROR,
        'No signed-in user for this request.',
      );
    }
    return actorUserId;
  }
}
