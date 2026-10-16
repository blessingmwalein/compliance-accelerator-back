import { describe, expect, it } from 'vitest';
import { makeSettings } from '../../test/support/auth-fixtures.js';
import { PasswordService } from './password.service.js';

const service = new PasswordService(makeSettings());

describe('PasswordService', () => {
  it('produces an argon2id PHC string with the configured cost and a fresh salt each time', async () => {
    const a = await service.hash('correct horse battery staple');
    const b = await service.hash('correct horse battery staple');
    expect(a.startsWith('$argon2id$')).toBe(true);
    expect(a).toContain('m=8192,t=2,p=1');
    expect(a).not.toBe(b);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const stored = await service.hash('correct horse battery staple');
    expect(await service.verify(stored, 'correct horse battery staple')).toBe(true);
    expect(await service.verify(stored, 'correct horse battery stapler')).toBe(false);
    expect(await service.verify(stored, '')).toBe(false);
  });

  it('treats a malformed stored hash as a failed verification instead of throwing', async () => {
    expect(await service.verify('not-a-hash', 'anything')).toBe(false);
    expect(await service.verify('', 'anything')).toBe(false);
  });

  it('the dummy verification completes without a stored hash', async () => {
    await expect(service.verifyDummy('whatever')).resolves.toBeUndefined();
  });

  it('never returns the password inside the hash', async () => {
    const stored = await service.hash('very-secret-passphrase-123');
    expect(stored).not.toContain('very-secret');
  });
});
