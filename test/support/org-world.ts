import { randomUUID } from 'node:crypto';
import { InvitationsService } from '../../src/organisations/invitations.service.js';
import { MembersService } from '../../src/organisations/members.service.js';
import type { InvitationRecord } from '../../src/organisations/invitations.repository.js';
import type { MembershipRecord } from '../../src/organisations/memberships.repository.js';
import type { InvitationByToken } from '../../src/organisations/invitation-token-lookup.repository.js';
import type { Role } from '../../src/permissions/catalogue.js';
import type { UserRecord } from '../../src/auth/users.repository.js';
import type { AuditEventInput } from '../../src/audit/audit.service.js';
import type { NewJob } from '../../src/jobs/jobs.repository.js';
import { sha256Hex } from '../../src/auth/tokens.js';
import { TestClock } from './auth-world.js';

export const ORG = '0198a0f6-7c2e-7a53-9b1e-0000000000a1';

/**
 * An in-memory stand-in for the organisation repositories with the same observable contract
 * (conditional updates return whether they won; the active-owner lock returns who is locked). The
 * business rules of MembersService and InvitationsService run for real: only persistence is faked.
 * Real database behaviour (constraints, concurrency, rollback, row-level security) is proven by the
 * integration specs.
 */
export function createOrgWorld() {
  const clock = new TestClock();
  const users: UserRecord[] = [];
  const memberships: MembershipRecord[] = [];
  const invitations: Array<InvitationRecord & { tokenHash: string | null; email: string }> = [];
  const tokenIndex = new Map<string, string>(); // tokenHash -> invitation id
  const jobs: NewJob[] = [];
  const jobKeys = new Set<string>();
  const audits: AuditEventInput[] = [];
  const context: { membershipId?: string; role?: Role; actorUserId?: string } = {};
  /** Test hook: pretend these owners are the only ones left once the lock is taken (a concurrent demotion). */
  const lock: { onlyOwners: string[] | null } = { onlyOwners: null };
  /** Test hook: make the next transaction fail like a unique-index violation. */
  const failNext: { code: string | null } = { code: null };

  const uow = {
    run: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      if (failNext.code) {
        const code = failNext.code;
        failNext.code = null;
        throw Object.assign(new Error('boom'), { code });
      }
      return fn({});
    },
  };

  // Real repositories return fresh objects: handing out the stored row would let a service see its own writes.
  const copy = <T extends object>(row: T): T => structuredClone(row);
  const copyOrNull = <T extends object>(row: T | undefined): T | null => (row ? copy(row) : null);

  const membershipsRepo = {
    list: async (_tx: unknown, o: { limit: number; after?: string }) =>
      memberships
        .filter((m) => !o.after || m.id > o.after)
        .slice(0, o.limit + 1)
        .map(copy),
    findById: async (_tx: unknown, id: string) => copyOrNull(memberships.find((m) => m.id === id)),
    findByUser: async (_tx: unknown, userId: string) =>
      copyOrNull(memberships.find((m) => m.userId === userId)),
    create: async (_tx: unknown, d: { userId: string; role: Role }) => {
      const user = users.find((u) => u.id === d.userId)!;
      const row: MembershipRecord = {
        id: randomUUID(),
        userId: d.userId,
        role: d.role,
        status: 'ACTIVE',
        version: 1,
        createdAt: clock.now(),
        user: { email: user.email, fullName: user.fullName, isActive: user.isActive },
      };
      memberships.push(row);
      return copy(row);
    },
    lockActiveOwners: async () =>
      lock.onlyOwners ??
      memberships
        .filter((m) => m.role === 'COMPANY_OWNER' && m.status === 'ACTIVE')
        .map((m) => m.id),
    update: async (
      _tx: unknown,
      id: string,
      version: number,
      d: { role?: Role; status?: 'ACTIVE' | 'DEACTIVATED' },
    ) => {
      const row = memberships.find((m) => m.id === id);
      if (!row || row.version !== version) return false;
      Object.assign(row, d, { version: row.version + 1 });
      return true;
    },
  };

  const invitationsRepo = {
    list: async (_tx: unknown, o: { limit: number; after?: string }) =>
      [...invitations]
        .reverse()
        .filter((i) => !o.after || i.id < o.after)
        .slice(0, o.limit + 1)
        .map(copy),
    findById: async (_tx: unknown, id: string) => copyOrNull(invitations.find((i) => i.id === id)),
    findPendingByEmail: async (_tx: unknown, email: string) =>
      copyOrNull(invitations.find((i) => i.email === email && i.status === 'PENDING')),
    create: async (
      _tx: unknown,
      d: { email: string; role: Role; expiresAt: Date; invitedByUserId: string },
    ) => {
      const row = {
        id: randomUUID(),
        email: d.email,
        role: d.role,
        status: 'PENDING' as const,
        expiresAt: d.expiresAt,
        sendCount: 0,
        version: 1,
        createdAt: clock.now(),
        invitedBy: {
          fullName: users.find((u) => u.id === d.invitedByUserId)?.fullName ?? 'Someone',
        },
        tokenHash: null,
      };
      invitations.push(row);
      return copy(row);
    },
    revoke: async (_tx: unknown, id: string) => {
      const row = invitations.find((i) => i.id === id && i.status === 'PENDING');
      if (!row) return false;
      row.status = 'REVOKED';
      row.tokenHash = null;
      row.version++;
      return true;
    },
    accept: async (_tx: unknown, id: string, tokenHash: string, _user: string, now: Date) => {
      const row = invitations.find(
        (i) =>
          i.id === id && i.status === 'PENDING' && i.tokenHash === tokenHash && i.expiresAt > now,
      );
      if (!row) return false;
      row.status = 'ACCEPTED';
      row.tokenHash = null;
      row.version++;
      return true;
    },
  };

  const lookupRepo = {
    find: async (tokenHash: string): Promise<InvitationByToken | null> => {
      const id = tokenIndex.get(tokenHash);
      const row = invitations.find((i) => i.id === id && i.tokenHash === tokenHash);
      if (!row) return null;
      return {
        invitationId: row.id,
        organisationId: ORG,
        organisationName: 'Acme Ltd',
        email: row.email,
        role: row.role,
        status: row.status,
        expiresAt: row.expiresAt,
      };
    },
  };

  const usersRepo = {
    findByEmail: async (email: string) => users.find((u) => u.email === email) ?? null,
    findById: async (id: string) => users.find((u) => u.id === id) ?? null,
  };
  const jobsService = {
    enqueue: async (job: NewJob) => {
      if (jobKeys.has(job.dedupeKey)) return false;
      jobKeys.add(job.dedupeKey);
      jobs.push(job);
      return true;
    },
  };
  const audit = { record: async (_tx: unknown, event: AuditEventInput) => void audits.push(event) };
  const requestContext = {
    get: () => context,
    requireOrganisationId: () => ORG,
    runInOrganisation: <T>(_id: string, fn: () => T): T => fn(),
  };

  /** No plan assigned = no limit: the real EntitlementsService is proven against the database. */
  const noLimit = { assertRoomForOneMoreUser: async () => undefined };

  const members = new MembersService(
    uow as never,
    membershipsRepo as never,
    audit as never,
    requestContext as never,
    noLimit as never,
  );
  const invites = new InvitationsService(
    uow as never,
    invitationsRepo as never,
    membershipsRepo as never,
    lookupRepo as never,
    usersRepo as never,
    jobsService as never,
    audit as never,
    requestContext as never,
    clock,
    noLimit as never,
  );

  function addUser(email: string, options: { verified?: boolean; name?: string } = {}): UserRecord {
    const user: UserRecord = {
      id: randomUUID(),
      email,
      fullName: options.name ?? email.split('@')[0]!,
      isActive: true,
      passwordHash: 'x',
      emailVerifiedAt: options.verified === false ? null : clock.now(),
      isPlatformAdmin: false,
      createdAt: clock.now(),
    };
    users.push(user);
    return user;
  }

  /** Adds a user with a membership. */
  function addMember(
    email: string,
    role: Role,
    status: 'ACTIVE' | 'DEACTIVATED' = 'ACTIVE',
  ): MembershipRecord {
    const user = addUser(email);
    const row: MembershipRecord = {
      id: randomUUID(),
      userId: user.id,
      role,
      status,
      version: 1,
      createdAt: clock.now(),
      user: { email, fullName: user.fullName, isActive: true },
    };
    memberships.push(row);
    return row;
  }

  /** Makes `member` the caller of the next service call (as the access guard would). */
  function actAs(member: MembershipRecord): void {
    Object.assign(context, {
      membershipId: member.id,
      role: member.role,
      actorUserId: member.userId,
    });
  }

  /** Stores a token as the email job would and returns the raw value the invitee receives. */
  function sendToken(invitationId: string): string {
    const raw = `raw-${randomUUID()}-${randomUUID()}`;
    const row = invitations.find((i) => i.id === invitationId)!;
    row.tokenHash = sha256Hex(raw);
    tokenIndex.set(row.tokenHash, row.id);
    return raw;
  }

  return {
    clock,
    members,
    invites,
    users,
    memberships,
    invitations,
    jobs,
    audits,
    lock,
    failNext,
    addUser,
    addMember,
    actAs,
    sendToken,
  };
}
