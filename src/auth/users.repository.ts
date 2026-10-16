import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface UserRecord {
  id: string;
  email: string;
  fullName: string;
  isActive: boolean;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
  isPlatformAdmin: boolean;
  createdAt: Date;
}

const SELECT = {
  id: true,
  email: true,
  fullName: true,
  isActive: true,
  passwordHash: true,
  emailVerifiedAt: true,
  isPlatformAdmin: true,
  createdAt: true,
} as const;

/** Users are global (not tenant-owned), so every method may run with or without an organisation. */
@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string, client: Tx = this.prisma.db): Promise<UserRecord | null> {
    return client.user.findUnique({ where: { email }, select: SELECT });
  }

  findById(id: string, client: Tx = this.prisma.db): Promise<UserRecord | null> {
    return client.user.findUnique({ where: { id }, select: SELECT });
  }

  /** Re-read on every platform request: revoking the flag applies at once. */
  async isPlatformAdmin(id: string): Promise<boolean> {
    const count = await this.prisma.db.user.count({
      where: { id, isPlatformAdmin: true, isActive: true },
    });
    return count === 1;
  }

  create(
    client: Tx,
    data: { email: string; fullName: string; passwordHash: string },
  ): Promise<UserRecord> {
    return client.user.create({ data, select: SELECT });
  }

  async markEmailVerified(client: Tx, userId: string, now: Date): Promise<void> {
    await client.user.updateMany({
      where: { id: userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: now },
    });
  }

  /** A successful reset also proves the address (the link went to it), so it verifies the email. */
  async setPassword(client: Tx, userId: string, passwordHash: string, now: Date): Promise<void> {
    await client.user.update({ where: { id: userId }, data: { passwordHash } });
    await this.markEmailVerified(client, userId, now);
  }

  async touchLogin(client: Tx, userId: string, now: Date): Promise<void> {
    await client.user.update({ where: { id: userId }, data: { lastLoginAt: now } });
  }
}
