import { describe, expect, it } from 'vitest';
import { assertTenantScoped, TenantScopeError } from './tenant-guard.js';

const A = '00000000-0000-7000-8000-00000000000a';
const B = '00000000-0000-7000-8000-00000000000b';

// `NO_TENANT` is explicit: passing `undefined` would trigger the default parameter.
const NO_TENANT = Symbol('no tenant');
const run = (
  model: string,
  operation: string,
  args: unknown,
  tenant: string | typeof NO_TENANT = A,
) =>
  assertTenantScoped({
    model,
    operation,
    args,
    tenantId: tenant === NO_TENANT ? undefined : tenant,
  });

const failureOf = (fn: () => void) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof TenantScopeError) return error.failure;
    throw error;
  }
  return 'none';
};

describe('assertTenantScoped', () => {
  describe('models that are not tenant-owned', () => {
    it.each([
      ['User', 'findUnique', { where: { id: 'x' } }],
      ['Organisation', 'findMany', {}],
    ])('does not check %s.%s', (model, operation, args) => {
      expect(failureOf(() => run(model, operation, args, NO_TENANT))).toBe('none');
    });
  });

  describe('outside a verified tenant scope', () => {
    it('rejects every tenant-model query, even one that names a tenant', () => {
      expect(
        failureOf(() => run('Membership', 'findMany', { where: { organisationId: A } }, NO_TENANT)),
      ).toBe('TENANT_CONTEXT_MISSING');
      expect(
        failureOf(() => run('AuditEvent', 'create', { data: { organisationId: A } }, NO_TENANT)),
      ).toBe('TENANT_CONTEXT_MISSING');
    });
  });

  describe('reads, updates and deletes', () => {
    it.each([
      'findMany',
      'findFirst',
      'findFirstOrThrow',
      'count',
      'aggregate',
      'groupBy',
      'updateMany',
      'deleteMany',
    ])('%s must pin organisationId', (operation) => {
      expect(failureOf(() => run('AuditEvent', operation, { where: { organisationId: A } }))).toBe(
        'none',
      );
      expect(failureOf(() => run('AuditEvent', operation, { where: { id: 'x' } }))).toBe(
        'TENANT_FILTER_MISSING',
      );
      expect(failureOf(() => run('AuditEvent', operation, {}))).toBe('TENANT_FILTER_MISSING');
      expect(failureOf(() => run('AuditEvent', operation, { where: { organisationId: B } }))).toBe(
        'TENANT_MISMATCH',
      );
    });

    it('rejects the bare-id lookup that caused the legacy leaks', () => {
      expect(failureOf(() => run('Membership', 'findUnique', { where: { id: 'x' } }))).toBe(
        'TENANT_FILTER_MISSING',
      );
      expect(failureOf(() => run('Membership', 'update', { where: { id: 'x' }, data: {} }))).toBe(
        'TENANT_FILTER_MISSING',
      );
      expect(failureOf(() => run('Membership', 'delete', { where: { id: 'x' } }))).toBe(
        'TENANT_FILTER_MISSING',
      );
    });

    it('accepts compound unique selectors that contain the tenant', () => {
      expect(
        failureOf(() =>
          run('Membership', 'findUnique', {
            where: { organisationId_id: { organisationId: A, id: 'x' } },
          }),
        ),
      ).toBe('none');
      expect(
        failureOf(() =>
          run('Membership', 'findUnique', {
            where: { organisationId_userId: { organisationId: B, userId: 'u' } },
          }),
        ),
      ).toBe('TENANT_MISMATCH');
    });

    it('accepts { equals } and AND, but never OR, NOT, in or not', () => {
      expect(
        failureOf(() =>
          run('Membership', 'findMany', { where: { organisationId: { equals: A } } }),
        ),
      ).toBe('none');
      expect(
        failureOf(() =>
          run('Membership', 'findMany', {
            where: { AND: [{ status: 'ACTIVE' }, { organisationId: A }] },
          }),
        ),
      ).toBe('none');
      expect(
        failureOf(() =>
          run('Membership', 'findMany', {
            where: { OR: [{ organisationId: A }, { organisationId: B }] },
          }),
        ),
      ).toBe('TENANT_FILTER_MISSING');
      expect(
        failureOf(() => run('Membership', 'findMany', { where: { NOT: { organisationId: B } } })),
      ).toBe('TENANT_FILTER_MISSING');
      expect(
        failureOf(() =>
          run('Membership', 'findMany', { where: { organisationId: { in: [A, B] } } }),
        ),
      ).toBe('TENANT_FILTER_MISSING');
      expect(
        failureOf(() => run('Membership', 'findMany', { where: { organisationId: { not: B } } })),
      ).toBe('TENANT_FILTER_MISSING');
    });

    it('treats a top-level filter as the AND of everything, so an OR branch cannot widen it', () => {
      expect(
        failureOf(() =>
          run('Membership', 'findMany', {
            where: { organisationId: A, OR: [{ organisationId: B }] },
          }),
        ),
      ).toBe('none');
    });
  });

  describe('creates', () => {
    it('create needs organisationId in data (scalar or connect form) equal to the tenant', () => {
      expect(
        failureOf(() => run('AuditEvent', 'create', { data: { organisationId: A, action: 'x' } })),
      ).toBe('none');
      expect(
        failureOf(() =>
          run('AuditEvent', 'create', { data: { organisation: { connect: { id: A } } } }),
        ),
      ).toBe('none');
      expect(failureOf(() => run('AuditEvent', 'create', { data: { action: 'x' } }))).toBe(
        'TENANT_FILTER_MISSING',
      );
      expect(failureOf(() => run('AuditEvent', 'create', { data: { organisationId: B } }))).toBe(
        'TENANT_MISMATCH',
      );
      expect(
        failureOf(() =>
          run('AuditEvent', 'create', { data: { organisation: { connect: { id: B } } } }),
        ),
      ).toBe('TENANT_MISMATCH');
    });

    it('createMany checks every row', () => {
      expect(
        failureOf(() =>
          run('IdempotencyKey', 'createMany', {
            data: [{ organisationId: A }, { organisationId: A }],
          }),
        ),
      ).toBe('none');
      expect(
        failureOf(() =>
          run('IdempotencyKey', 'createMany', {
            data: [{ organisationId: A }, { organisationId: B }],
          }),
        ),
      ).toBe('TENANT_MISMATCH');
      expect(
        failureOf(() => run('IdempotencyKey', 'createMany', { data: [{ organisationId: A }, {}] })),
      ).toBe('TENANT_FILTER_MISSING');
      expect(failureOf(() => run('IdempotencyKey', 'createMany', { data: [] }))).toBe('none');
    });

    it('upsert checks both the where and the create payload', () => {
      const ok = {
        where: { organisationId_id: { organisationId: A, id: 'x' } },
        create: { organisationId: A },
        update: {},
      };
      expect(failureOf(() => run('Membership', 'upsert', ok))).toBe('none');
      expect(
        failureOf(() => run('Membership', 'upsert', { ...ok, create: { organisationId: B } })),
      ).toBe('TENANT_MISMATCH');
      expect(failureOf(() => run('Membership', 'upsert', { ...ok, where: { id: 'x' } }))).toBe(
        'TENANT_FILTER_MISSING',
      );
    });
  });

  it('fails closed on operations it does not know', () => {
    expect(
      failureOf(() => run('Membership', 'someFutureOperation', { where: { organisationId: A } })),
    ).toBe('TENANT_FILTER_MISSING');
  });

  it('names the model and operation but never leaks tenant ids in the message', () => {
    try {
      run('AuditEvent', 'findMany', { where: { organisationId: B } });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('AuditEvent.findMany');
      expect((error as Error).message).not.toContain(A);
      expect((error as Error).message).not.toContain(B);
    }
  });
});
