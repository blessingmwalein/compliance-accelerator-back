import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';
import { makeSettings, TEST_JWT_SECRET } from '../../test/support/auth-fixtures.js';
import { AccessTokenService } from './access-token.service.js';

const jwt = new JwtService();
const settings = makeSettings();
const service = new AccessTokenService(jwt, settings);

const reject = async (token: string) => {
  try {
    await service.verify(token);
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return 'ACCEPTED';
};

describe('AccessTokenService', () => {
  it('round-trips the two claims and nothing else', async () => {
    const token = await service.sign({ sub: 'user-1', sid: 'session-1' });
    expect(await service.verify(token)).toEqual({ sub: 'user-1', sid: 'session-1' });

    const payload = jwt.decode<Record<string, unknown>>(token);
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'sid', 'sub']);
  });

  it('expires after the configured lifetime', async () => {
    const token = await service.sign({ sub: 'u', sid: 's' });
    const { iat, exp } = jwt.decode<{ iat: number; exp: number }>(token);
    expect(exp - iat).toBe(900);
  });

  it('rejects a token signed with another secret', async () => {
    const forged = await jwt.signAsync(
      { sub: 'u', sid: 's' },
      { secret: `${TEST_JWT_SECRET}-other`, algorithm: 'HS256' },
    );
    expect(await reject(forged)).toBe('UNAUTHENTICATED');
  });

  it('rejects an expired token', async () => {
    const expired = await jwt.signAsync(
      { sub: 'u', sid: 's' },
      { secret: TEST_JWT_SECRET, algorithm: 'HS256', expiresIn: -10 },
    );
    expect(await reject(expired)).toBe('UNAUTHENTICATED');
  });

  it('rejects the alg:none attack and other algorithms', async () => {
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"u","sid":"s"}').toString('base64url')}.`;
    expect(await reject(none)).toBe('UNAUTHENTICATED');
    const hs512 = await jwt.signAsync(
      { sub: 'u', sid: 's' },
      { secret: TEST_JWT_SECRET, algorithm: 'HS512' },
    );
    expect(await reject(hs512)).toBe('UNAUTHENTICATED');
  });

  it('rejects a validly signed token that lacks the claims', async () => {
    const noSid = await jwt.signAsync(
      { sub: 'u' },
      { secret: TEST_JWT_SECRET, algorithm: 'HS256' },
    );
    expect(await reject(noSid)).toBe('UNAUTHENTICATED');
  });

  it('rejects garbage and tampering', async () => {
    expect(await reject('not.a.jwt')).toBe('UNAUTHENTICATED');
    const token = await service.sign({ sub: 'u', sid: 's' });
    const [header, , signature] = token.split('.');
    const tampered = `${header}.${Buffer.from('{"sub":"admin","sid":"s"}').toString('base64url')}.${signature}`;
    expect(await reject(tampered)).toBe('UNAUTHENTICATED');
  });
});
