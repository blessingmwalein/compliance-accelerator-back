import { describe, expect, it } from 'vitest';
import { RequestContext, TenantContextMissingError } from './request-context.js';

describe('RequestContext', () => {
  const context = new RequestContext();

  it('has no tenant outside a scope and refuses to invent one', () => {
    expect(context.organisationId).toBeUndefined();
    expect(() => context.requireOrganisationId()).toThrow(TenantContextMissingError);
  });

  it('carries the scope across awaits', async () => {
    await context.run({ organisationId: 'org-a' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(context.requireOrganisationId()).toBe('org-a');
    });
  });

  it('keeps concurrent scopes apart', async () => {
    const seen = await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        context.run({ organisationId: id }, async () => {
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
          return context.requireOrganisationId();
        }),
      ),
    );
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('lets a guard enrich the active scope', () => {
    context.run({}, () => {
      expect(context.actorUserId).toBeUndefined();
      context.update({ actorUserId: 'u1', organisationId: 'org-a' });
      expect(context.actorUserId).toBe('u1');
      expect(context.organisationId).toBe('org-a');
    });
  });

  it('refuses to update outside a scope', () => {
    expect(() => context.update({ organisationId: 'x' })).toThrow('No active request scope');
  });

  it('runInOrganisation switches tenant but keeps actor and request id, then restores the outer scope', () => {
    context.run({ actorUserId: 'u1', requestIdOf: () => 'req-1', organisationId: 'org-a' }, () => {
      context.runInOrganisation('org-b', () => {
        expect(context.organisationId).toBe('org-b');
        expect(context.actorUserId).toBe('u1');
        expect(context.requestId).toBe('req-1');
      });
      expect(context.organisationId).toBe('org-a');
    });
  });

  it('starts a lazy thenable (like a Prisma query) inside the scope, not wherever it is later awaited', async () => {
    // Prisma promises run their work only when `then` is first called, like this stand-in
    const lazyQuery = (): PromiseLike<string | undefined> => ({
      then: (onFulfilled, onRejected) =>
        Promise.resolve(context.organisationId).then(onFulfilled, onRejected),
    });
    const seen = await context.run({ organisationId: 'org-a' }, () => lazyQuery());
    expect(seen).toBe('org-a');
    // awaited outside any scope, the same thenable sees no tenant: this is the trap being guarded
    expect(await lazyQuery()).toBeUndefined();
  });

  it('reads the request id lazily', () => {
    const request: { id?: string } = {};
    context.run({ requestIdOf: () => request.id }, () => {
      expect(context.requestId).toBeUndefined();
      request.id = 'assigned-later';
      expect(context.requestId).toBe('assigned-later');
    });
  });
});
