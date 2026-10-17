import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { MYSQL_MIGRATION_DEADLINE_MS, withMysqlMigrationLock } from './mysqlMigrationLock.js';
import { isMysqlStorageUnavailable, leaseMysqlConnection, MysqlDeadline } from '../userPool/mysqlDeadline.js';
import { MYSQL_BASE_TABLES, MYSQL_SCHEMA, mysqlCreateTable, validateMysqlSchema } from './mysqlSchema.js';

export const INITIAL_SCHEMA_MIGRATION = '2026-08-27-proxy-mysql-initial';
export const TOKEN_COLLATION_MIGRATION = '2026-08-27-proxy-token-binary-collation';

const MANUAL_SCHEMA_HINT = 'Ask a database administrator to apply scripts/proxy-mysql-initial.sql '
  + 'and grant the runtime account the required permissions.';

/**
 * MYSQL_AUTO_MIGRATE=false: a database administrator prepared the schema. Validate it read-only
 * (no DDL, no migration lock) against the same definition auto-migration would create, so a
 * missing column or table fails at startup instead of on the first request that touches it.
 */
export async function validateMysqlTables(pool: Pool): Promise<void> {
  await validatePreparedMysqlSchema(pool, (connection) => validateMysqlSchema(connection, MYSQL_BASE_TABLES));
}

export async function validatePreparedMysqlSchema(pool: Pool, validate: (connection: PoolConnection) => Promise<unknown>): Promise<void> {
  const deadline = new MysqlDeadline(MYSQL_MIGRATION_DEADLINE_MS, MYSQL_MIGRATION_DEADLINE_MS);
  const lease = await leaseMysqlConnection(pool, deadline);
  try {
    await validate(lease.connection);
  } catch (cause) {
    if (isMysqlStorageUnavailable(cause)) throw cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Proxy MySQL schema is not ready for MYSQL_AUTO_MIGRATE=false: ${detail} ${MANUAL_SCHEMA_HINT}`, { cause });
  } finally {
    lease.release();
  }
}

export async function runMysqlMigrations(pool: Pool): Promise<void> {
  await withMysqlMigrationLock(pool, async connection => {
    await validateMysqlSchema(connection, ['schema_migrations'], { allowMissingTables: true });
    const [tables] = await connection.query<RowDataPacket[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations'");
    const [tokenMigrationRows] = tables.length ? await connection.execute<RowDataPacket[]>(
      'SELECT 1 FROM schema_migrations WHERE id = ?', [TOKEN_COLLATION_MIGRATION]) : [[]];
    // Retain the known historical CI-token upgrade, but never use it to repair an altered type
    // or a collation whose migration was already recorded as complete.
    await validateMysqlSchema(connection, MYSQL_BASE_TABLES, { allowMissingTables: true, allowLegacyStats: true,
      allowLegacyTokenCollation: tokenMigrationRows.length === 0 });
    for (const table of MYSQL_BASE_TABLES) await connection.query(mysqlCreateTable(table));
    await connection.execute('INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES (?, UTC_TIMESTAMP(3))', [INITIAL_SCHEMA_MIGRATION]);
    if (tokenMigrationRows.length === 0) {
      await connection.query('ALTER TABLE proxy_accounts MODIFY copilot_oauth_token TEXT COLLATE utf8mb4_bin');
      await connection.execute('INSERT INTO schema_migrations (id, applied_at) VALUES (?, UTC_TIMESTAMP(3))', [TOKEN_COLLATION_MIGRATION]);
    }
    for (const column of ['caller_id', 'lease_id']) {
      const [columns] = await connection.execute<RowDataPacket[]>(
        'SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
        ['proxy_request_stats', column]);
      if (!columns.length) await connection.query(`ALTER TABLE proxy_request_stats ADD COLUMN ${column} ${MYSQL_SCHEMA.proxy_request_stats.columns[column]}`);
    }
    await validateMysqlSchema(connection, MYSQL_BASE_TABLES);
  });
}
