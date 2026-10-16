/**
 * Where uploaded files live (ADR-0007). Callers never build a path or URL: they hand over bytes and get
 * back a key to store in the database, and files are only ever served through an authorised endpoint
 * (proxied), never from a public address. Development and tests use the local driver; production will
 * use an S3-compatible driver behind the same contract (gate G0).
 */
export interface StoredFile {
  size: number;
  /** SHA-256 (hex) of the bytes, computed here on the server, never taken from the client. */
  sha256: string;
}

export abstract class StorageProvider {
  /** Stores `data` under `key` (replacing any file with that key) and reports its size and checksum. */
  abstract put(key: string, data: Buffer): Promise<StoredFile>;
  /** The bytes under `key`, or null when there is no such file. */
  abstract get(key: string): Promise<Buffer | null>;
  /** Removes the file; a missing file is not an error. */
  abstract delete(key: string): Promise<void>;
}

/** Keys are opaque, lower-case path-like strings such as `org/<id>/logo/<uuid>`: no dots, no traversal. */
export const STORAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/;
