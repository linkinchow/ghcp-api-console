import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import {
  MYSQL_MIGRATION_DEADLINE_MS,
  MYSQL_MIGRATION_LOCK_WAIT,
  withMysqlMigrationLock,
} from './mysqlMigrationLock.js';
import { isMysqlStorageUnavailable, leaseMysqlConnection, MysqlDeadline } from '../userPool/mysqlDeadline.js';
import { MYSQL_BASE_TABLES, MYSQL_SCHEMA, mysqlCreateTable, validateMysqlSchema } from './mysqlSchema.js';
import { ENTERPRISE_MIGRATION_IDS } from './enterpriseMigrationIds.js';
import type { EnterpriseSeed } from './enterpriseSeed.js';
import {
  allRecorded,
  enterpriseColumn,
  insertDefaultEnterprise,
  MYSQL_BASE_ENTERPRISE_STEPS,
  recordedMigrations,
  recordMigration,
  runMysqlMigrationSteps,
  syncMysqlRegistryEnterprises,
  tableExists,
  verifyDefaultEnterprise,
} from './mysqlEnterpriseMigrations.js';

export const INITIAL_SCHEMA_MIGRATION = '2026-08-27-proxy-mysql-initial';
export const TOKEN_COLLATION_MIGRATION = '2026-08-27-proxy-token-binary-collation';

const MANUAL_SCHEMA_HINT = 'Ask a database administrator to apply scripts/proxy-mysql-initial.sql '
  + 'and grant the runtime account the required permissions.';
const ENTERPRISE_UPGRADE_HINT = 'This is a single-enterprise (r4) schema. Ask a database administrator to apply '
  + 'scripts/proxy-mysql-enterprise-upgrade.sql.';

/**
 * MYSQL_AUTO_MIGRATE=false: a database administrator prepared the schema. Validate it read-only
 * (no DDL, no migration lock) against the same definition auto-migration would create, so a
 * missing column or table fails at startup instead of on the first request that touches it.
 */
export async function validateMysqlTables(pool: Pool): Promise<void> {
  await validatePreparedMysqlSchema(pool, (connection) => validateMysqlSchema(connection, MYSQL_BASE_TABLES),
    ['proxy_accounts', 'proxy_enterprises']);
}

/** `upgradeTables`: when one of them lacks `enterprise_id` (or is missing), the hint names the upgrade script. */
export async function validatePreparedMysqlSchema(pool: Pool,
  validate: (connection: PoolConnection) => Promise<unknown>, upgradeTables: readonly string[] = []): Promise<void> {
  const deadline = new MysqlDeadline(MYSQL_MIGRATION_DEADLINE_MS, MYSQL_MIGRATION_DEADLINE_MS);
  const lease = await leaseMysqlConnection(pool, deadline);
  try {
    await validate(lease.connection);
  } catch (cause) {
    if (isMysqlStorageUnavailable(cause)) throw cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    const hint = await preparedSchemaHint(lease.connection, upgradeTables);
    throw new Error(`Proxy MySQL schema is not ready for MYSQL_AUTO_MIGRATE=false: ${detail} ${hint}`, { cause });
  } finally {
    lease.release();
  }
}

async function preparedSchemaHint(connection: PoolConnection, upgradeTables: readonly string[]): Promise<string> {
  try {
    return await isSingleEnterpriseSchema(connection, upgradeTables) ? ENTERPRISE_UPGRADE_HINT : MANUAL_SCHEMA_HINT;
  } catch {
    return MANUAL_SCHEMA_HINT;
  }
}

/** The r4 schema: Proxy tables exist, but some table the upgrade extends has no `enterprise_id` yet. */
async function isSingleEnterpriseSchema(connection: PoolConnection, tables: readonly string[]): Promise<boolean> {
  if (!tables.length || !await tableExists(connection, 'proxy_accounts')) return false;
  for (const table of tables) {
    if (table === 'proxy_enterprises' && !await tableExists(connection, table)) return true;
    if (table !== 'proxy_enterprises' && !await enterpriseColumn(connection, table)) return true;
  }
  return false;
}

/**
 * MYSQL_AUTO_MIGRATE=false: after validation, insert the `default` enterprise when missing (a database
 * prepared from the initial script has none) and check its identity. Data only, never DDL.
 */
export async function prepareMysqlEnterprises(pool: Pool, seed: EnterpriseSeed,
  lockWaitSeconds: number = MYSQL_MIGRATION_LOCK_WAIT.defaultSeconds): Promise<void> {
  await withMysqlMigrationLock(pool, async (connection) => {
    await insertDefaultEnterprise(connection, seed);
    await verifyDefaultEnterprise(connection, seed);
    await recordMigration(connection, ENTERPRISE_MIGRATION_IDS.seedDefault);
  }, lockWaitSeconds);
}

/** Every registry enterprise besides `default` (design §3.6), in the migration lock; data only, never DDL. */
export async function syncMysqlEnterprises(pool: Pool, seeds: readonly EnterpriseSeed[],
  lockWaitSeconds: number = MYSQL_MIGRATION_LOCK_WAIT.defaultSeconds): Promise<void> {
  await withMysqlMigrationLock(pool, (connection) => syncMysqlRegistryEnterprises(connection, seeds), lockWaitSeconds);
}

export async function runMysqlMigrations(pool: Pool, seed: EnterpriseSeed,
  lockWaitSeconds: number = MYSQL_MIGRATION_LOCK_WAIT.defaultSeconds): Promise<void> {
  await withMysqlMigrationLock(pool, async connection => {
    await validateMysqlSchema(connection, ['schema_migrations'], { allowMissingTables: true });
    const recorded = await recordedMigrations(connection);
    // Retain the known historical CI-token upgrade, but never use it to repair an altered type
    // or a collation whose migration was already recorded as complete.
    const tokenMigrated = recorded.has(TOKEN_COLLATION_MIGRATION);
    await validateMysqlSchema(connection, MYSQL_BASE_TABLES, { allowMissingTables: true, allowLegacyStats: true,
      allowLegacyTokenCollation: !tokenMigrated,
      allowPendingEnterprise: !allRecorded(recorded, MYSQL_BASE_ENTERPRISE_STEPS) });
    for (const table of MYSQL_BASE_TABLES) await connection.query(mysqlCreateTable(table));
    await connection.execute('INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES (?, UTC_TIMESTAMP(3))', [INITIAL_SCHEMA_MIGRATION]);
    if (!tokenMigrated) {
      await connection.query('ALTER TABLE proxy_accounts MODIFY copilot_oauth_token TEXT COLLATE utf8mb4_bin');
      await connection.execute('INSERT INTO schema_migrations (id, applied_at) VALUES (?, UTC_TIMESTAMP(3))', [TOKEN_COLLATION_MIGRATION]);
    }
    await addLegacyStatsColumns(connection);
    await migrateEnterprises(connection, seed);
    await validateMysqlSchema(connection, MYSQL_BASE_TABLES);
  }, lockWaitSeconds);
}

async function addLegacyStatsColumns(connection: PoolConnection): Promise<void> {
  for (const column of ['caller_id', 'lease_id']) {
    const [columns] = await connection.execute<RowDataPacket[]>(
      'SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
      ['proxy_request_stats', column]);
    const definition = MYSQL_SCHEMA.proxy_request_stats.columns[column];
    if (!columns.length) await connection.query(`ALTER TABLE proxy_request_stats ADD COLUMN ${column} ${definition}`);
  }
}

/** Design §4.2 MySQL steps 1–6 and 9. The seed row precedes step 03's foreign key. */
async function migrateEnterprises(connection: PoolConnection, seed: EnterpriseSeed): Promise<void> {
  await insertDefaultEnterprise(connection, seed);
  await runMysqlMigrationSteps(connection, MYSQL_BASE_ENTERPRISE_STEPS);
  await verifyDefaultEnterprise(connection, seed);
}
