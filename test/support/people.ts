import { randomUUID } from 'node:crypto';
import { AccessTokenService } from '../../src/auth/access-token.service.js';
import { ROLES, type Role } from '../../src/permissions/catalogue.js';
import type { IntContext } from './int-context.js';

export interface Person {
  id: string;
  email: string;
  fullName: string;
  /** A valid access token for a live session (as if the person had signed in). */
  token: string;
}

/** `Authorization: Bearer ...` for supertest: `.set(as(person))`. */
export const as = (person: Person) => ({ Authorization: `Bearer ${person.token}` });

/**
 * A user with a live session, created directly with the owner-role client (a handful of queries instead
 * of the register, confirm and sign-in round trips, which the authentication specs already cover).
 */
export async function createPerson(
  ctx: IntContext,
  options: { email?: string; label?: string; verified?: boolean } = {},
): Promise<Person> {
  const label = options.label ?? 'person';
  const email = options.email ?? `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const user = await ctx.admin.user.create({
    data: {
      email,
      fullName: `Person ${label}`,
      emailVerifiedAt: options.verified === false ? null : new Date(),
    },
  });
  const session = await ctx.admin.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
  });
  const token = await ctx.app
    .get(AccessTokenService, { strict: false })
    .sign({ sub: user.id, sid: session.id });
  return { id: user.id, email, fullName: user.fullName, token };
}

export interface Member extends Person {
  membershipId: string;
  role: Role;
}

/** An organisation with one active member per role (the minimum for a permission matrix). */
export async function createOrganisationWithAllRoles(ctx: IntContext, label: string) {
  const organisation = await ctx.admin.organisation.create({
    data: { name: `Org ${label} ${randomUUID().slice(0, 6)}`, timezone: 'Africa/Harare' },
  });
  const byRole = {} as Record<Role, Member>;
  for (const role of ROLES) {
    const person = await createPerson(ctx, { label: `${label}-${role.toLowerCase()}` });
    const membership = await ctx.admin.membership.create({
      data: { organisationId: organisation.id, userId: person.id, role },
    });
    byRole[role] = { ...person, membershipId: membership.id, role };
  }
  return { organisation, byRole };
}
