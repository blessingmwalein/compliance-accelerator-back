import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { AuthSettings } from './auth-settings.js';

/**
 * argon2id hashing (parameters from configuration, OWASP minimum by default). The salt is random per
 * hash and stored inside the PHC string. `@node-rs/argon2` ships prebuilt binaries and has no
 * install script (ADR-0003). It defaults to Argon2id; its `Algorithm` enum is a const enum that
 * `isolatedModules` cannot use, so password.service.spec.ts asserts the "argon2id" prefix of the
 * output instead, which catches a library change that would silently downgrade the algorithm.
 */
@Injectable()
export class PasswordService {
  private dummyHash: Promise<string> | undefined;

  constructor(private readonly settings: AuthSettings) {}

  hash(password: string): Promise<string> {
    return hash(password, {
      memoryCost: this.settings.argon2.memoryCost,
      timeCost: this.settings.argon2.timeCost,
      parallelism: 1,
    });
  }

  /** False for a wrong password AND for a malformed stored hash: never throws on bad input. */
  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, password);
    } catch {
      return false;
    }
  }

  /**
   * Spends the same time as a real verification, for logins against accounts that do not exist (or
   * have no password), so response time does not reveal whether the address is registered.
   */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash('dummy-password-for-constant-timing');
    await this.verify(await this.dummyHash, password);
  }
}
