import { closeSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ServiceEnv } from './defaultFromEnv.js';
import type { SecretRef } from './registryFields.js';

export const SECRET_MAX_BYTES = 128 * 1024;
export const SECRET_FILE_CACHE_MS = 60_000;

export type SecretErrorCode = 'enterprise_secret_unconfigured' | 'enterprise_secret_invalid';

/** Carries only the field path, such as `contoso-eu.sso.scimToken`; never the value or its source. */
export class SecretError extends Error {
  constructor(readonly code: SecretErrorCode, readonly field: string, reason: string) {
    super(`${field} ${reason}.`);
    this.name = 'SecretError';
  }
}

export interface ReadSecretOptions {
  /** Field path reported in errors, e.g. `contoso-eu.sso.scimToken`. */
  field: string;
  env: ServiceEnv;
  now?: () => number;
  readFile?: (path: string) => Buffer | string;
  /** The oldest cached file value this call accepts; 0 reads the file now. */
  maxAgeMs?: number;
}

interface CachedSecret {
  readonly value: string;
  readonly readAt: number;
}

const fileCache = new Map<string, CachedSecret>();

/**
 * Resolves a secret reference lazily (design §3.4). `{env}` is read on every call; `{file}` is cached for 60 s
 * so rotated mounts are picked up without a restart. One trailing newline is removed.
 */
export function readSecret(ref: SecretRef, options: ReadSecretOptions): string {
  if ('env' in ref) return checkContent(options.env[ref.env], options.field);
  return readSecretFile(ref.file, options);
}

/** Forgets cached file secrets; for tests and explicit rotation. */
export function clearSecretCache(): void {
  fileCache.clear();
}

function readSecretFile(path: string, options: ReadSecretOptions): string {
  if (!isAbsolute(path)) {
    throw new SecretError('enterprise_secret_invalid', options.field, 'must reference an absolute path');
  }
  const now = (options.now ?? Date.now)();
  const cached = fileCache.get(path);
  if (cached && now - cached.readAt < (options.maxAgeMs ?? SECRET_FILE_CACHE_MS)) return cached.value;
  const value = checkContent(loadFile(path, options), options.field);
  fileCache.set(path, { value, readAt: now });
  return value;
}

function loadFile(path: string, options: ReadSecretOptions): Buffer | string | undefined {
  try {
    return (options.readFile ?? readBoundedFile)(path);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw new SecretError('enterprise_secret_invalid', options.field, 'could not be read');
  }
}

function checkContent(content: Buffer | string | undefined, field: string): string {
  if (content === undefined) throw new SecretError('enterprise_secret_unconfigured', field, 'is not configured');
  const size = typeof content === 'string' ? Buffer.byteLength(content) : content.length;
  if (size > SECRET_MAX_BYTES) throw new SecretError('enterprise_secret_invalid', field, 'exceeds 128 KiB');
  const text = typeof content === 'string' ? content : content.toString('utf8');
  if (text.includes('\0')) throw new SecretError('enterprise_secret_invalid', field, 'contains a NUL byte');
  const value = text.replace(/\r?\n$/, '');
  if (!value) throw new SecretError('enterprise_secret_unconfigured', field, 'is empty');
  return value;
}

/** Reads at most one byte past the limit so an oversized file is detected without loading it whole. */
function readBoundedFile(path: string): Buffer {
  const buffer = Buffer.alloc(SECRET_MAX_BYTES + 1);
  const fd = openSync(path, 'r');
  try {
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
