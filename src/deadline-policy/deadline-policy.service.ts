import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import type { DeadlinePolicyChanges, DeadlinePolicyRecord } from './deadline-policy.repository.js';
import { DeadlinePolicyRepository } from './deadline-policy.repository.js';
import type { DeadlinePolicyDto, UpdateDeadlinePolicyDto } from './deadline-policy.dto.js';

/**
 * A window is a choice this organisation made, not a fact the platform verified. The wording travels with
 * the numbers so no screen can present them as a legal requirement (grc-domain section 8).
 */
export const DEADLINE_POLICY_DISCLAIMER =
  "These windows are the organisation's own choices. Fernando Compliance Accelerator does not check them " +
  'against any statute and does not guarantee that they satisfy any legal deadline. A window that is not ' +
  'set leaves the records that would have used it without one.';

const versionConflict = () =>
  new AppException(
    ErrorCode.VersionConflict,
    HttpStatus.CONFLICT,
    'The deadline policy was changed by someone else. Reload and try again.',
  );

/**
 * The organisation's deadline policy (AC-DSAR-03, AC-BRC-01). The DSAR and breach services read it through
 * `policyInForce` and copy its numbers onto each record at creation, so a report shows the deadline the
 * record was actually worked to and a later change to the policy never rewrites history.
 */
@Injectable()
export class DeadlinePolicyService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly policies: DeadlinePolicyRepository,
    private readonly audit: AuditService,
  ) {}

  get(): Promise<DeadlinePolicyDto> {
    return this.uow.run((tx) => this.policies.get(tx)).then(toDto);
  }

  /**
   * The policy in force, inside a caller's transaction, or null when the organisation has never set one.
   * A null is not a failure and has no fallback: the caller freezes `null` windows and the record reports
   * `not_configured`.
   */
  policyInForce(tx: Tx): Promise<DeadlinePolicyRecord | null> {
    return this.policies.get(tx);
  }

  /**
   * Omit a field to keep it, send `null` to unset it. The row is created on the first change (version 1)
   * and every later change carries that version back.
   */
  update(dto: UpdateDeadlinePolicyDto): Promise<DeadlinePolicyDto> {
    return this.uow.run(async (tx) => {
      const current = await this.policies.get(tx);
      if ((current?.version ?? 0) !== dto.version) throw versionConflict();

      const changes: DeadlinePolicyChanges = {};
      // Named fields, not a spread: what is stored is exactly the six numbers this endpoint accepts.
      for (const field of FIELDS) {
        const value = dto[field];
        if (value !== undefined) changes[field] = value;
      }
      if (Object.keys(changes).length === 0) return toDto(current);

      const record = current
        ? await this.applyUpdate(tx, current, changes)
        : await this.policies.create(tx, changes);
      await this.audit.record(tx, {
        action: 'deadline_policy.updated',
        entityType: 'deadline_policy',
        entityId: record.id,
        // field names only: a window is a number the organisation chose, and the trail shows what moved
        changes: Object.fromEntries(Object.keys(changes).map((field) => [field, 'changed'])),
      });
      return toDto(record);
    });
  }

  private async applyUpdate(
    tx: Tx,
    current: DeadlinePolicyRecord,
    changes: DeadlinePolicyChanges,
  ): Promise<DeadlinePolicyRecord> {
    const updated = await this.policies.update(tx, current.id, current.version, changes);
    if (!updated) throw versionConflict();
    return { ...current, ...changes, version: current.version + 1 };
  }
}

const FIELDS = [
  'dsarResponseDays',
  'dsarExtensionDays',
  'dsarExtensionLimit',
  'breachAssessmentDays',
  'breachNotificationDays',
  'alertLeadDays',
] as const satisfies readonly (keyof UpdateDeadlinePolicyDto)[];

/** The six windows, whether any is set, and the version a client has to send back. */
function toDto(record: DeadlinePolicyRecord | null): DeadlinePolicyDto {
  return {
    dsarResponseDays: record?.dsarResponseDays ?? null,
    dsarExtensionDays: record?.dsarExtensionDays ?? null,
    dsarExtensionLimit: record?.dsarExtensionLimit ?? null,
    breachAssessmentDays: record?.breachAssessmentDays ?? null,
    breachNotificationDays: record?.breachNotificationDays ?? null,
    alertLeadDays: record?.alertLeadDays ?? null,
    configured: record !== null && FIELDS.some((field) => record[field] !== null),
    version: record?.version ?? 0,
    disclaimer: DEADLINE_POLICY_DISCLAIMER,
  };
}
