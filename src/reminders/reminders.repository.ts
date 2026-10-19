import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import type { ReminderSourceKind, ReminderStatus } from '../domain/incidents/reminders.js';
import { toDateOnly, utcDay } from '../domain/registers/review.js';
import { Prisma } from '../generated/prisma/client.js';
import { RequestContext } from '../tenancy/request-context.js';

/**
 * A reminder row as the API reads it. `dueOn` is the DATE column already reduced to its calendar day,
 * because the domain's deadline view and the alert dedupe key both compare days, never instants — and the
 * column is NOT NULL, so there is always a day.
 */
export interface ReminderRecord {
  id: string;
  title: string;
  note: string | null;
  dueOn: string;
  leadDays: number | null;
  status: ReminderStatus;
  assigneeMembershipId: string | null;
  assigneeName: string | null;
  sourceKind: ReminderSourceKind | null;
  sourceId: string | null;
  sourceLabel: string | null;
  createdByUserId: string;
  completedOn: Date | null;
  completedByUserId: string | null;
  cancelledOn: Date | null;
  cancelledByUserId: string | null;
  cancelReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

/** What a create writes. `createdByUserId` comes from the request scope, never from the client. */
export interface ReminderCreateData {
  title: string;
  note: string | null;
  dueOn: string;
  leadDays: number | null;
  assigneeMembershipId: string | null;
  sourceKind: ReminderSourceKind | null;
  sourceId: string | null;
  sourceLabel: string | null;
  createdByUserId: string;
}

/** The columns an edit or a status step may write; `status` and its stamps move together or not at all. */
export type ReminderUpdateData = {
  title?: string;
  note?: string | null;
  dueOn?: string;
  assigneeMembershipId?: string | null;
  status?: ReminderStatus;
  completedOn?: Date | null;
  completedByUserId?: string | null;
  cancelledOn?: Date | null;
  cancelledByUserId?: string | null;
  cancelReason?: string | null;
};

export interface ListOptions {
  limit: number;
  after?: string;
  q?: string;
  status?: ReminderStatus;
  sourceKind?: ReminderSourceKind;
  assigneeMembershipId?: string;
  /** Only reminders due on or before this calendar day (`YYYY-MM-DD`). */
  dueBefore?: string;
  /** Hide DONE and CANCELLED reminders: a view that only wants what is still owed. */
  excludeSettled?: boolean;
}

/** One member's stored email choices (`reminder_preferences` has no other columns). */
export interface ReminderPreferenceRecord {
  id: string;
  membershipId: string;
  emailDueSoon: boolean;
  emailOverdue: boolean;
  updatedAt: Date;
}

export type PreferenceData = { emailDueSoon: boolean; emailOverdue: boolean };

/** What a reminder alert needs to re-check at send time, and nothing else. */
export interface ReminderAlertState {
  status: ReminderStatus;
  dueOn: string;
  assigneeMembershipId: string | null;
}

const SELECT = {
  id: true,
  title: true,
  note: true,
  dueOn: true,
  leadDays: true,
  status: true,
  assigneeMembershipId: true,
  sourceKind: true,
  sourceId: true,
  sourceLabel: true,
  createdByUserId: true,
  completedOn: true,
  completedByUserId: true,
  cancelledOn: true,
  cancelledByUserId: true,
  cancelReason: true,
  createdAt: true,
  updatedAt: true,
  version: true,
  // the name the row shows; the alert itself only ever names the ROLE
  assignee: { select: { user: { select: { fullName: true } } } },
} as const;

type ReminderRow = Prisma.ReminderGetPayload<{ select: typeof SELECT }>;

const toRecord = ({ assignee, dueOn, ...rest }: ReminderRow): ReminderRecord => ({
  ...rest,
  dueOn: toDateOnly(dueOn) ?? '',
  assigneeName: assignee?.user.fullName ?? null,
});

const PREFERENCE_SELECT = {
  id: true,
  membershipId: true,
  emailDueSoon: true,
  emailOverdue: true,
  updatedAt: true,
} as const;

const ALERT_STATE_SELECT = {
  status: true,
  dueOn: true,
  assigneeMembershipId: true,
} as const;

/**
 * The reminders of the CURRENT organisation, in creation order (ids are UUIDv7). A reminder is never
 * deleted: there is no delete method here, and the lifecycle ends at DONE or CANCELLED.
 */
@Injectable()
export class RemindersRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  async list(tx: Tx, options: ListOptions): Promise<ReminderRecord[]> {
    const rows = await tx.reminder.findMany({
      where: {
        organisationId: this.organisationId,
        ...(options.status
          ? { status: options.status }
          : options.excludeSettled
            ? { status: 'PENDING' }
            : {}),
        ...(options.sourceKind ? { sourceKind: options.sourceKind } : {}),
        ...(options.assigneeMembershipId
          ? { assigneeMembershipId: options.assigneeMembershipId }
          : {}),
        ...(options.dueBefore ? { dueOn: { lte: utcDay(options.dueBefore) } } : {}),
        ...(options.after ? { id: { gt: options.after } } : {}),
        ...(options.q
          ? {
              OR: [
                { title: { contains: options.q, mode: 'insensitive' as const } },
                { note: { contains: options.q, mode: 'insensitive' as const } },
                { sourceLabel: { contains: options.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { id: 'asc' },
      take: options.limit + 1,
      select: SELECT,
    });
    return rows.map(toRecord);
  }

  findById(tx: Tx, id: string): Promise<ReminderRecord | null> {
    return tx.reminder
      .findFirst({ where: { id, organisationId: this.organisationId }, select: SELECT })
      .then((row) => (row === null ? null : toRecord(row)));
  }

  create(tx: Tx, data: ReminderCreateData): Promise<ReminderRecord> {
    const { dueOn, ...rest } = data;
    return tx.reminder
      .create({
        data: { ...rest, dueOn: utcDay(dueOn), organisationId: this.organisationId },
        select: SELECT,
      })
      .then(toRecord);
  }

  /** Optimistic locking: the write lands only while the row still carries the version that was read. */
  async update(tx: Tx, id: string, version: number, data: ReminderUpdateData): Promise<boolean> {
    const { dueOn, ...rest } = data;
    const result = await tx.reminder.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: {
        ...rest,
        ...(dueOn === undefined ? {} : { dueOn: utcDay(dueOn) }),
        version: { increment: 1 },
      },
    });
    return result.count === 1;
  }

  // ---- the member's own email choices

  findPreference(tx: Tx, membershipId: string): Promise<ReminderPreferenceRecord | null> {
    return tx.reminderPreference.findFirst({
      where: { organisationId: this.organisationId, membershipId },
      select: PREFERENCE_SELECT,
    });
  }

  createPreference(
    tx: Tx,
    membershipId: string,
    data: PreferenceData,
  ): Promise<ReminderPreferenceRecord> {
    return tx.reminderPreference.create({
      data: { ...data, organisationId: this.organisationId, membershipId },
      select: PREFERENCE_SELECT,
    });
  }

  /** The table has no `version` column, so the write is keyed on the membership's unique row. */
  async updatePreference(
    tx: Tx,
    membershipId: string,
    data: PreferenceData,
  ): Promise<ReminderPreferenceRecord | null> {
    const updated = await tx.reminderPreference.updateMany({
      where: { organisationId: this.organisationId, membershipId },
      data,
    });
    return updated.count === 0 ? null : this.findPreference(tx, membershipId);
  }

  // ---- what the alert job re-reads at send time (jobs run at least once)

  /** The reminder an alert row names; null when the row is not a reminder's. */
  async findAlertReminderId(tx: Tx, alertId: string): Promise<string | null> {
    const row = await tx.alertDelivery.findFirst({
      where: { id: alertId, organisationId: this.organisationId },
      select: { reminderId: true },
    });
    return row?.reminderId ?? null;
  }

  findAlertState(tx: Tx, reminderId: string): Promise<ReminderAlertState | null> {
    return tx.reminder
      .findFirst({
        where: { id: reminderId, organisationId: this.organisationId },
        select: ALERT_STATE_SELECT,
      })
      .then((row) =>
        row === null
          ? null
          : {
              status: row.status,
              dueOn: toDateOnly(row.dueOn) ?? '',
              assigneeMembershipId: row.assigneeMembershipId,
            },
      );
  }

  /**
   * The assignee's address, and only while their membership is ACTIVE: a departed member's mailbox is not a
   * live recipient, and the ledger must record the absence rather than write to a stranger.
   */
  async findAlertAssignee(
    tx: Tx,
    membershipId: string,
  ): Promise<{ id: string; email: string } | null> {
    const row = await tx.membership.findFirst({
      where: { id: membershipId, organisationId: this.organisationId, status: 'ACTIVE' },
      select: { id: true, user: { select: { email: true } } },
    });
    return row === null ? null : { id: row.id, email: row.user.email };
  }

  // ---- the organisation's own rules

  /** An ACTIVE member of this organisation, with the name the list shows beside the reminder. */
  async findActiveMember(
    tx: Tx,
    membershipId: string,
  ): Promise<{ id: string; fullName: string } | null> {
    const row = await tx.membership.findFirst({
      where: { id: membershipId, organisationId: this.organisationId, status: 'ACTIVE' },
      select: { id: true, user: { select: { fullName: true } } },
    });
    return row === null ? null : { id: row.id, fullName: row.user.fullName };
  }

  /** The tenant's IANA zone: a due date and its alert instant are decided in it, never in UTC. */
  async timezone(tx: Tx): Promise<string> {
    const row = await tx.organisation.findUnique({
      where: { id: this.organisationId },
      select: { timezone: true },
    });
    if (!row) {
      throw new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Organisation not found.');
    }
    return row.timezone;
  }
}
