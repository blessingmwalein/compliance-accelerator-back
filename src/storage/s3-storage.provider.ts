import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { EnvironmentVariables } from '../config/env.schema.js';
import { STORAGE_KEY_PATTERN, StorageProvider, type StoredFile } from './storage-provider.js';

/**
 * Files in an S3-compatible object store (ADR-0007): evidence, generated report PDFs and the company logo,
 * in one private bucket addressed by the opaque keys the database already holds. Supabase Storage speaks this
 * protocol, and so do R2, B2, Wasabi and AWS S3, which is why the endpoint is configuration rather than a
 * second driver per vendor.
 *
 * Nothing here is public: the bucket is read by these three calls only, and bytes reach a browser through the
 * authorised download endpoints, so no object ever has a URL of its own to leak.
 */
@Injectable()
export class S3StorageProvider extends StorageProvider {
  private readonly logger = new Logger(S3StorageProvider.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    super();
    const endpoint = config.get('STORAGE_S3_ENDPOINT', { infer: true });
    const region = config.get('STORAGE_S3_REGION', { infer: true });
    this.bucket = config.get('STORAGE_S3_BUCKET', { infer: true });
    if (!endpoint || !region || !this.bucket) {
      // validateEnv refuses this combination at boot; this is the check that does not depend on it.
      throw new Error(
        'STORAGE_DRIVER=s3 needs STORAGE_S3_ENDPOINT, STORAGE_S3_REGION and STORAGE_S3_BUCKET',
      );
    }
    this.client = new S3Client({
      endpoint,
      region,
      credentials: {
        accessKeyId: config.get('STORAGE_S3_ACCESS_KEY_ID', { infer: true }) ?? '',
        secretAccessKey: config.get('STORAGE_S3_SECRET_ACCESS_KEY', { infer: true }) ?? '',
      },
      // Supabase addresses a bucket as `<endpoint>/<bucket>/<key>`; the virtual-host form is its CDN's own
      // `<bucket>.<endpoint>` and is not what the S3 endpoint answers.
      forcePathStyle: config.get('STORAGE_S3_FORCE_PATH_STYLE', { infer: true }) ?? true,
      // SDK versions from 3.729 on attach a streaming checksum trailer to every PutObject unless asked not
      // to, and S3-compatible hosts that are not Amazon's own reject it. `when_required` still signs the
      // requests; it only stops inventing a header the operation does not need.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  /** Stores the bytes and reports what they are: the checksum is measured here, never taken from the store. */
  async put(key: string, data: Buffer): Promise<StoredFile> {
    this.assertKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        // A key is reused when a file is replaced, and the object store must not keep two answers under it.
        ContentType: 'application/octet-stream',
      }),
    );
    return { size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  }

  /** The bytes under `key`, or null when there is no such file. */
  async get(key: string): Promise<Buffer | null> {
    this.assertKey(key);
    try {
      const found = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!found.Body) return null;
      return Buffer.from(await found.Body.transformToByteArray());
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      // A store that is unreachable is not an empty folder: saying so keeps a 404 honest.
      if (!this.isMissing(error)) throw error;
      return null;
    }
  }

  /** Removes the file; a missing file is not an error, which is also what S3 itself answers. */
  async delete(key: string): Promise<void> {
    this.assertKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      // Only the cleanup after a failed write may not throw: a record that was never stored must still be
      // reported as the failure that it is, not hidden behind an unremovable object.
      this.logger.warn(`delete ${key} failed: ${(error as Error).name}`);
      throw error;
    }
  }

  /** Keys are opaque, server-made strings; anything else is a programming error, and a traversal attempt. */
  private assertKey(key: string): void {
    if (!STORAGE_KEY_PATTERN.test(key)) throw new Error('Invalid storage key');
  }

  /** `NoSuchKey` is typed, but S3-compatible hosts answer the same fact as a plain 404. */
  private isMissing(error: unknown): boolean {
    const statusCode = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode;
    const name = (error as { name?: string; Code?: string }).name;
    const code = (error as { Code?: string }).Code;
    return statusCode === 404 || name === 'NoSuchKey' || code === 'NoSuchKey';
  }
}
