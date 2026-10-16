import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { AuthSettings } from './auth-settings.js';

export type HashPurpose = 'account' | 'ip' | 'subject';

/**
 * Keyed (HMAC-SHA-256) hashes of email addresses and client IPs, for lockout counters and security
 * events. A plain hash of an email or IPv4 address is trivially reversible by guessing; with a
 * server-side key it is not, so the tables hold no raw addresses of people who may not even exist.
 * The purpose is mixed in, so an account hash can never be mistaken for an IP hash.
 */
@Injectable()
export class KeyedHasher {
  constructor(private readonly settings: AuthSettings) {}

  hash(purpose: HashPurpose, value: string): string {
    return createHmac('sha256', this.settings.hashKey)
      .update(`${purpose}:${value.trim().toLowerCase()}`)
      .digest('hex');
  }
}
