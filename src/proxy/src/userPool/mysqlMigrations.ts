import { createHash } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { MYSQL_MIGRATION_LOCK_WAIT, withMysqlMigrationLock } from '../db/mysqlMigrationLock.js';
import { validatePreparedMysqlSchema } from '../db/mysqlMigrations.js';
import { MYSQL_BASE_TABLES, MYSQL_POOL_TABLES, MYSQL_CREDENTIAL_FENCE_DDL,
  mysqlCreateTable, validateMysqlSchema, validateMysqlCredentialFence } from '../db/mysqlSchema.js';
import { ENTERPRISE_MIGRATION_IDS } from '../db/enterpriseMigrationIds.js';
import {
  allRecorded,
  MYSQL_POOL_ENTERPRISE_STEPS,
  recordedMigrations,
  recordMigration,
  runMysqlMigrationSteps,
} from '../db/mysqlEnterpriseMigrations.js';
import { normalizePoolConfig, type PoolConfig } from './config.js';

export const POOL_SCHEMA_MIGRATION = '2026-09-12-user-pool-mysql-v1';

/** Requires the base Proxy migrations first. MySQL DDL auto-commits; every step is restartable. */
export async function runMysqlPoolMigrations(pool: Pool, options: PoolConfig,
  lockWaitSeconds: number = MYSQL_MIGRATION_LOCK_WAIT.defaultSeconds): Promise<void> {
  await withMysqlMigrationLock(pool, async connection => {
    await validateMysqlSchema(connection, MYSQL_BASE_TABLES);
    const recorded = await recordedMigrations(connection);
    const applied = recorded.has(POOL_SCHEMA_MIGRATION);
    await validateMysqlSchema(connection, MYSQL_POOL_TABLES, { allowMissingTables: !applied,
      allowPendingEnterprise: !allRecorded(recorded, MYSQL_POOL_ENTERPRISE_STEPS) });
    // A previously-installed fence disappearing makes intervening credential changes unknowable.
    // Validate its body before any DDL; never replace an altered or previously installed fence.
    const hasFence = await validateMysqlCredentialFence(connection, !applied);
    for (const table of MYSQL_POOL_TABLES) await connection.query(mysqlCreateTable(table));
    if (!hasFence) await connection.query(MYSQL_CREDENTIAL_FENCE_DDL);
    await runMysqlMigrationSteps(connection, MYSQL_POOL_ENTERPRISE_STEPS);
    await migratePoolConfigFingerprint(connection, options);
    await validateMysqlSchema(connection, MYSQL_POOL_TABLES);
    await validateMysqlCredentialFence(connection);
    await connection.execute('INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES (?, UTC_TIMESTAMP(3))', [POOL_SCHEMA_MIGRATION]);
  }, lockWaitSeconds);
}

/**
 * MYSQL_AUTO_MIGRATE=false with the user pool enabled: verify the administrator-prepared pool tables
 * and credential fence without DDL. MySQL only exposes trigger metadata to accounts holding the
 * TRIGGER privilege on proxy_accounts, so the runtime account needs it to prove the fence exists.
 * The fingerprint step only rewrites data, so it runs here too.
 */
export async function validateMysqlPoolSchema(pool: Pool, options: PoolConfig,
  lockWaitSeconds: number = MYSQL_MIGRATION_LOCK_WAIT.defaultSeconds): Promise<void> {
  await validatePreparedMysqlSchema(pool, async (connection) => {
    await validateMysqlSchema(connection, MYSQL_POOL_TABLES);
    await validateMysqlCredentialFence(connection);
  }, ['user_pool_accounts', 'user_pool_events']);
  await withMysqlMigrationLock(pool, (connection) => migratePoolConfigFingerprint(connection, options),
    lockWaitSeconds);
}

/**
 * Shared settings that every replica must agree on. Targets, cap and lease duration are mutable settings,
 * and the account domain is per enterprise: its `profile_fingerprint` covers it.
 */
export function poolConfigFingerprint(options: PoolConfig): string {
  const { accountDomain: _domain, ...invariants } = poolInvariants(options);
  return fingerprint(invariants);
}

/** The single-enterprise fingerprint, which still covered the account domain. */
export function singleEnterprisePoolConfigFingerprint(options: PoolConfig): string {
  return fingerprint(poolInvariants(options));
}

function poolInvariants(options: PoolConfig): Partial<PoolConfig> {
  const { idleTarget: _idle, maxAccounts: _max, leaseSeconds: _lease, enabled: _enabled,
    callerDomain: _legacy, ...invariants } = normalizePoolConfig(options);
  return invariants;
}

function fingerprint(invariants: Partial<PoolConfig>): string {
  return createHash('sha256')
    .update(JSON.stringify(Object.entries(invariants).sort(([a], [b]) => a.localeCompare(b))))
    .digest('hex');
}

/**
 * Design §4.2 MySQL step 8, inside the migration lock. A replica whose configuration matches the stored
 * fingerprint (either algorithm) rewrites it; afterwards single-enterprise replicas can no longer start.
 */
async function migratePoolConfigFingerprint(connection: PoolConnection, options: PoolConfig): Promise<void> {
  const id = ENTERPRISE_MIGRATION_IDS.poolConfigFingerprint;
  if ((await recordedMigrations(connection)).has(id)) return;
  const stored = await storedPoolFingerprint(connection);
  const current = poolConfigFingerprint(options);
  if (stored !== undefined && stored !== current) {
    if (stored !== singleEnterprisePoolConfigFingerprint(options)) {
      throw new Error('Pool configuration differs between Proxy replicas');
    }
    await connection.query(`
      UPDATE user_pool_settings
      SET config_fingerprint = ?
      WHERE id = 1
    `, [current]);
  }
  await recordMigration(connection, id);
}

async function storedPoolFingerprint(connection: PoolConnection): Promise<string | undefined> {
  const [rows] = await connection.query<RowDataPacket[]>(`
    SELECT config_fingerprint
    FROM user_pool_settings
    WHERE id = 1
  `);
  return rows[0] ? String(rows[0].config_fingerprint) : undefined;
}
