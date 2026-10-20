import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { pageSizeOf, toPage } from '../common/pagination.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { auditCsv, MAX_AUDIT_EXPORT_ROWS } from './audit-csv.js';
import type { AuditEventDto, AuditEventPageDto, ListAuditQueryDto } from './audit.dto.js';
import type { AuditEventRecord, AuditListOptions } from './audit.repository.js';
import { AuditRepository } from './audit.repository.js';
import { AuditService } from './audit.service.js';

/** The finished file: the bytes as text, the name to offer them under, and how many events are in it. */
export interface AuditCsvFile {
  csv: string;
  filename: string;
  rowCount: number;
}

/**
 * The read side of the trail (AC-AUD-03): search and export, both organisation-scoped, both read-only.
 *
 * It is a separate service from `AuditService` on purpose — the writer is injected into every module and
 * must stay a single, fail-closed `record` call, while this one needs a transaction of its own and is used
 * only by the Audit Trail endpoints. Nothing here can change or remove an event: the table is append-only
 * by trigger and `UPDATE`/`DELETE` are revoked from the application role, so an export is the only way any
 * of this data leaves, and that is why it is audited.
 */
@Injectable()
export class AuditTrailService {
  constructor(
    private readonly repository: AuditRepository,
    private readonly audit: AuditService,
    private readonly uow: UnitOfWork,
  ) {}

  async list(query: ListAuditQueryDto): Promise<AuditEventPageDto> {
    const limit = pageSizeOf(query);
    return this.uow.run(async (tx) => {
      const rows = await this.repository.list(tx, this.optionsOf(query, limit));
      const page = toPage(rows, limit);
      return { items: page.items.map((row) => this.toDto(row)), nextCursor: page.nextCursor };
    });
  }

  /**
   * The filtered trail as CSV, with the export itself recorded in the trail it reads.
   *
   * The rows are read before the audit event is written, so an export never contains its own `audit.exported`
   * row. A period that matches more than `MAX_AUDIT_EXPORT_ROWS` is refused rather than silently cut: the
   * caller can narrow the range and try again, and the ledger does not lose the difference.
   */
  async export(query: ListAuditQueryDto): Promise<AuditCsvFile> {
    const rows = await this.uow.run(async (tx) => {
      const found = await this.repository.list(
        tx,
        this.optionsOf(query, MAX_AUDIT_EXPORT_ROWS + 1),
      );
      if (found.length > MAX_AUDIT_EXPORT_ROWS) {
        throw new AppException(
          ErrorCode.ExportRangeTooLarge,
          HttpStatus.UNPROCESSABLE_ENTITY,
          `This period holds more than ${MAX_AUDIT_EXPORT_ROWS} events. Narrow the range, export, then continue from the last event.`,
        );
      }
      await this.audit.record(tx, {
        action: 'audit.exported',
        entityType: 'audit_event',
        entityLabel: 'Audit trail export',
        changes: { format: 'csv', rows: found.length, ...this.filtersOf(query) },
      });
      return found;
    });

    return {
      csv: auditCsv(rows),
      filename: `audit-trail-${new Date().toISOString().slice(0, 10)}.csv`,
      rowCount: rows.length,
    };
  }

  private optionsOf(query: ListAuditQueryDto, limit: number): AuditListOptions {
    return { limit, ...this.filtersOf(query), ...(query.after ? { after: query.after } : {}) };
  }

  /** Only the filters that were actually given: an absent one is no filter, not a null match. */
  private filtersOf(query: ListAuditQueryDto): Omit<AuditListOptions, 'limit' | 'after'> {
    return {
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
    };
  }

  private toDto(record: AuditEventRecord): AuditEventDto {
    return {
      id: record.id,
      occurredAt: record.occurredAt.toISOString(),
      actorType: record.actorType,
      actorUserId: record.actorUserId,
      action: record.action as AuditEventDto['action'],
      entityType: record.entityType,
      entityId: record.entityId,
      entityLabel: record.entityLabel,
      outcome: record.outcome,
      requestId: record.requestId,
      changes: (record.changes as Record<string, unknown> | null) ?? null,
    };
  }
}
