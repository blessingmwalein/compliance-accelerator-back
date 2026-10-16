import { TENANT_MODELS } from './catalogue.js';

export type TenantScopeFailure =
  'TENANT_CONTEXT_MISSING' | 'TENANT_FILTER_MISSING' | 'TENANT_MISMATCH';

/**
 * A repository called a tenant model without proving the tenant. This is a programming error (500),
 * never a user error: the fix is in the repository. The message names the model and operation only.
 */
export class TenantScopeError extends Error {
  constructor(
    readonly failure: TenantScopeFailure,
    readonly model: string,
    readonly operation: string,
  ) {
    super(`Tenant scope violation (${failure}) on ${model}.${operation}`);
    this.name = 'TenantScopeError';
  }
}

const TENANT_MODEL_SET: ReadonlySet<string> = new Set(TENANT_MODELS);

const FILTERED_OPERATIONS: ReadonlySet<string> = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
]);
const CREATE_OPERATIONS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
]);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The organisation a `where` pins at its top level (directly, via a compound key, or inside AND). */
function pinnedInWhere(where: unknown): string | undefined {
  if (!isObject(where)) return undefined;

  const direct = where.organisationId;
  if (typeof direct === 'string') return direct;
  if (isObject(direct) && typeof direct.equals === 'string') return direct.equals;

  for (const [key, value] of Object.entries(where)) {
    // compound unique selectors such as `organisationId_id: { organisationId, id }`
    if (
      key.startsWith('organisationId_') &&
      isObject(value) &&
      typeof value.organisationId === 'string'
    ) {
      return value.organisationId;
    }
  }

  // AND narrows, so an organisation pinned in any member of AND pins the whole query. OR and NOT
  // widen or invert, so they never count.
  const and = where.AND;
  for (const member of Array.isArray(and) ? and : and === undefined ? [] : [and]) {
    const pinned = pinnedInWhere(member);
    if (pinned !== undefined) return pinned;
  }
  return undefined;
}

/** The organisation a create payload sets (`organisationId`, or `organisation: { connect: { id } }`). */
function pinnedInData(data: unknown): string | undefined {
  if (!isObject(data)) return undefined;
  if (typeof data.organisationId === 'string') return data.organisationId;
  const organisation = data.organisation;
  if (
    isObject(organisation) &&
    isObject(organisation.connect) &&
    typeof organisation.connect.id === 'string'
  ) {
    return organisation.connect.id;
  }
  return undefined;
}

function check(
  pinned: string | undefined,
  tenantId: string,
  model: string,
  operation: string,
): void {
  if (pinned === undefined) throw new TenantScopeError('TENANT_FILTER_MISSING', model, operation);
  if (pinned !== tenantId) throw new TenantScopeError('TENANT_MISMATCH', model, operation);
}

export interface TenantScopeInput {
  model: string;
  operation: string;
  args: unknown;
  /** The verified tenant of the current request, if any. */
  tenantId: string | undefined;
}

/**
 * The Prisma safety net's rule (layer 3 of ADR-0004). For a tenant model, every query must run
 * inside a verified tenant scope AND pin `organisationId` to that same tenant: reads, updates and
 * deletes in their `where`, creates in their `data`. It ASSERTS instead of injecting the filter so
 * a missing filter in a repository is found by tests, not silently repaired. Unknown operations on
 * tenant models are rejected (fail closed). Non-tenant models and raw SQL are not covered here:
 * raw SQL is where leaks hide, so it is forbidden outside repositories and reviewed by hand.
 */
export function assertTenantScoped({ model, operation, args, tenantId }: TenantScopeInput): void {
  if (!TENANT_MODEL_SET.has(model)) return;
  if (tenantId === undefined)
    throw new TenantScopeError('TENANT_CONTEXT_MISSING', model, operation);

  const input = isObject(args) ? args : {};

  if (FILTERED_OPERATIONS.has(operation)) {
    check(pinnedInWhere(input.where), tenantId, model, operation);
    return;
  }

  if (CREATE_OPERATIONS.has(operation)) {
    const rows = Array.isArray(input.data) ? input.data : [input.data];
    if (rows.length === 0) return;
    for (const row of rows) check(pinnedInData(row), tenantId, model, operation);
    return;
  }

  if (operation === 'upsert') {
    check(pinnedInWhere(input.where), tenantId, model, operation);
    check(pinnedInData(input.create), tenantId, model, operation);
    return;
  }

  throw new TenantScopeError('TENANT_FILTER_MISSING', model, operation);
}
