import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hkdfSync } from 'node:crypto';
import { parseCorsOrigins, type EnvironmentVariables } from '../config/env.schema.js';

/** Authentication settings, read once from the validated environment. */
@Injectable()
export class AuthSettings {
  readonly jwtSecret: string;
  readonly accessTtlSeconds: number;
  readonly sessionTtlMs: number;
  readonly refreshReuseGraceMs: number;
  readonly appBaseUrl: string;
  readonly allowedOrigins: readonly string[];
  readonly cookie: { secure: boolean; domain: string | undefined };
  readonly argon2: { memoryCost: number; timeCost: number };
  /** Key for the keyed hashes of account and IP, derived from the JWT secret (rotating it resets counters, harmless). */
  readonly hashKey: Buffer;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    this.jwtSecret = config.get('JWT_ACCESS_SECRET', { infer: true });
    this.accessTtlSeconds = config.get('JWT_ACCESS_TTL_SECONDS', { infer: true });
    this.sessionTtlMs = config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }) * 24 * 60 * 60 * 1000;
    this.refreshReuseGraceMs = config.get('REFRESH_REUSE_GRACE_SECONDS', { infer: true }) * 1000;
    this.appBaseUrl = config.get('APP_BASE_URL', { infer: true }).replace(/\/+$/, '');
    this.allowedOrigins = parseCorsOrigins(config.get('CORS_ORIGINS', { infer: true }));
    this.cookie = {
      secure: config.get('COOKIE_SECURE', { infer: true }) === true,
      domain: config.get('COOKIE_DOMAIN', { infer: true }) || undefined,
    };
    this.argon2 = {
      memoryCost: config.get('ARGON2_MEMORY_KIB', { infer: true }),
      timeCost: config.get('ARGON2_TIME_COST', { infer: true }),
    };
    this.hashKey = Buffer.from(
      hkdfSync('sha256', this.jwtSecret, Buffer.alloc(0), 'fca-keyed-hash-v1', 32),
    );
  }
}
