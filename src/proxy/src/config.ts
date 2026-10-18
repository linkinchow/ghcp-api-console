import 'dotenv/config';
import { DEFAULT_ENTERPRISE_ID, parseEnterpriseId, type EnterpriseId } from '@ghcp/shared';
import { assertMysqlMigrationLockWait, MYSQL_MIGRATION_LOCK_WAIT } from './db/mysqlMigrationLock.js';

export interface ProxyConfig {
  port: number;
  storageDriver: 'sqlite' | 'mysql';
  dbPath: string;
  mysqlUrl?: string;
  mysqlAutoMigrate: boolean;
  /** MYSQL_MIGRATION_LOCK_WAIT_SECONDS: how long a replica waits for another replica's schema migration. */
  mysqlMigrationLockWaitSeconds: number;
  mysqlConnectionLimit: number;
  mysqlSslMode: 'disabled' | 'required' | 'verify-ca';
  mysqlSslCaPath?: string;
  identityInitLeaseSeconds: number;
  apiKey: string;
  identityHeader: string;
  identityHeaderRequired: boolean;
  claudeCodeOptimized: boolean;
  /** DIRECT_MODE_ENTERPRISE_ID: the enterprise of new direct-mode identities; it must be in the registry. */
  directModeEnterpriseId: EnterpriseId;
  internalApiToken: string;
  ssoBaseUrl: string;
  loginBaseUrl: string;
  requestStatsPerAccountLimit: number;
  errorDiagnosticsEnabled: boolean;
  errorDiagnosticsDir: string;
  errorDiagnosticsRedact: boolean;
  errorDiagnosticsMaxFileBytes: number;
  errorDiagnosticsMaxFiles: number;
  errorDiagnosticsShared: boolean;
  errorDiagnosticsInstanceId: string;
  opencodeUserAgent: string;
  githubApiVersion: string;
}

export const config: ProxyConfig = {
  port: readPort(process.env.PORT, 3000),
  storageDriver: readStorageDriver(process.env.STORAGE_DRIVER),
  dbPath: process.env.DB_PATH ?? './data/proxy.sqlite',
  mysqlUrl: readOptionalString(process.env.MYSQL_URL),
  mysqlAutoMigrate: readBoolean(process.env.MYSQL_AUTO_MIGRATE, true),
  mysqlMigrationLockWaitSeconds: readMigrationLockWait(process.env.MYSQL_MIGRATION_LOCK_WAIT_SECONDS),
  mysqlConnectionLimit: readPositiveInteger(process.env.MYSQL_CONNECTION_LIMIT, 10),
  mysqlSslMode: readMysqlSslMode(process.env.MYSQL_SSL_MODE),
  mysqlSslCaPath: readOptionalString(process.env.MYSQL_SSL_CA_PATH),
  identityInitLeaseSeconds: readPositiveInteger(process.env.IDENTITY_INIT_LEASE_SECONDS, 900),
  apiKey: process.env.API_KEY ?? '',
  identityHeader: process.env.IDENTITY_HEADER ?? 'X-User-Identity',
  identityHeaderRequired: readBoolean(process.env.IDENTITY_HEADER_REQUIRED, true),
  claudeCodeOptimized: readBoolean(process.env.CLAUDE_CODE_OPTIMIZED, false),
  directModeEnterpriseId: readEnterpriseId(process.env.DIRECT_MODE_ENTERPRISE_ID),
  internalApiToken: process.env.INTERNAL_API_TOKEN ?? '',
  ssoBaseUrl: process.env.SSO_BASE_URL ?? 'http://localhost:7001',
  loginBaseUrl: process.env.LOGIN_BASE_URL ?? 'http://localhost:7003',
  requestStatsPerAccountLimit: readPositiveInteger(process.env.REQUEST_STATS_PER_ACCOUNT_LIMIT, 2),
  errorDiagnosticsEnabled: readBoolean(process.env.PROXY_ERROR_DIAGNOSTICS_ENABLED, true),
  errorDiagnosticsDir: readOptionalString(process.env.PROXY_ERROR_DIAGNOSTICS_DIR) ?? './data/error-diagnostics',
  errorDiagnosticsRedact: readBoolean(process.env.PROXY_ERROR_DIAGNOSTICS_REDACT, false),
  errorDiagnosticsMaxFileBytes: readPositiveInteger(process.env.PROXY_ERROR_DIAGNOSTICS_MAX_FILE_MB, 50) * 1024 * 1024,
  errorDiagnosticsMaxFiles: readPositiveInteger(process.env.PROXY_ERROR_DIAGNOSTICS_MAX_FILES, 5),
  errorDiagnosticsShared: readBoolean(process.env.PROXY_ERROR_DIAGNOSTICS_SHARED, false),
  errorDiagnosticsInstanceId: readOptionalString(process.env.PROXY_INSTANCE_ID)
    ?? readOptionalString(process.env.HOSTNAME)
    ?? 'proxy',
  opencodeUserAgent: readOptionalString(process.env.OPENCODE_USER_AGENT)
    ?? `opencode/${readOptionalString(process.env.OPENCODE_VERSION) ?? '1.0.0'}`,
  githubApiVersion: readOptionalString(process.env.GITHUB_API_VERSION) ?? '2026-06-01',
};

if (config.storageDriver === 'mysql' && !config.mysqlUrl) {
  throw new Error('MYSQL_URL is required when STORAGE_DRIVER=mysql.');
}
if (config.mysqlSslMode === 'verify-ca' && !config.mysqlSslCaPath) {
  throw new Error('MYSQL_SSL_CA_PATH is required when MYSQL_SSL_MODE=verify-ca.');
}

function readPort(value: string | undefined, defaultValue: number): number {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) throw new Error(`Invalid PORT "${value}".`);
  return parsed;
}

function readPositiveInteger(value: string | undefined, defaultValue: number): number {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid positive integer "${value}".`);
  return parsed;
}

function readMigrationLockWait(value: string | undefined): number {
  const seconds = value?.trim() ? Number(value) : MYSQL_MIGRATION_LOCK_WAIT.defaultSeconds;
  return assertMysqlMigrationLockWait(seconds);
}

export function readBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error(`Invalid boolean "${value}".`);
}

function readStorageDriver(value: string | undefined): ProxyConfig['storageDriver'] {
  const normalized = value?.trim().toLowerCase() || 'sqlite';
  if (normalized === 'sqlite' || normalized === 'mysql') return normalized;
  throw new Error(`Invalid STORAGE_DRIVER "${value}". Expected "sqlite" or "mysql".`);
}

function readMysqlSslMode(value: string | undefined): ProxyConfig['mysqlSslMode'] {
  const normalized = value?.trim().toLowerCase() || 'disabled';
  if (normalized === 'disabled' || normalized === 'required' || normalized === 'verify-ca') return normalized;
  throw new Error(`Invalid MYSQL_SSL_MODE "${value}". Expected "disabled", "required", or "verify-ca".`);
}

function readEnterpriseId(value: string | undefined): EnterpriseId {
  const id = readOptionalString(value);
  if (id === undefined) return DEFAULT_ENTERPRISE_ID;
  try {
    return parseEnterpriseId(id);
  } catch {
    throw new Error(`Invalid DIRECT_MODE_ENTERPRISE_ID "${value}".`);
  }
}

function readOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
