import type { Pool, RowDataPacket } from 'mysql2/promise';
import { withMysqlMigrationLock } from '../db/mysqlMigrationLock.js';
import { validatePreparedMysqlSchema } from '../db/mysqlMigrations.js';
import { MYSQL_BASE_TABLES, MYSQL_POOL_TABLES, MYSQL_CREDENTIAL_FENCE_DDL,
  mysqlCreateTable, validateMysqlSchema, validateMysqlCredentialFence } from '../db/mysqlSchema.js';

export const POOL_SCHEMA_MIGRATION = '2026-09-12-user-pool-mysql-v1';

/** Requires the base Proxy migrations first. MySQL DDL auto-commits; every step is restartable. */
export async function runMysqlPoolMigrations(pool: Pool): Promise<void> {
  await withMysqlMigrationLock(pool, async connection => {
    await validateMysqlSchema(connection, MYSQL_BASE_TABLES);
    const [applied] = await connection.query<RowDataPacket[]>('SELECT 1 FROM schema_migrations WHERE id=?', [POOL_SCHEMA_MIGRATION]);
    await validateMysqlSchema(connection, MYSQL_POOL_TABLES, { allowMissingTables: applied.length === 0 });
    // A previously-installed fence disappearing makes intervening credential changes unknowable.
    // Validate its body before any DDL; never replace an altered or previously installed fence.
    const hasFence = await validateMysqlCredentialFence(connection, applied.length === 0);
    for (const table of MYSQL_POOL_TABLES) await connection.query(mysqlCreateTable(table));
    if (!hasFence) await connection.query(MYSQL_CREDENTIAL_FENCE_DDL);
    await validateMysqlSchema(connection, MYSQL_POOL_TABLES);
    await validateMysqlCredentialFence(connection);
    await connection.execute('INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES (?, UTC_TIMESTAMP(3))', [POOL_SCHEMA_MIGRATION]);
  });
}

/**
 * MYSQL_AUTO_MIGRATE=false with the user pool enabled: verify the administrator-prepared pool tables
 * and credential fence without DDL. MySQL only exposes trigger metadata to accounts holding the
 * TRIGGER privilege on proxy_accounts, so the runtime account needs it to prove the fence exists.
 */
export async function validateMysqlPoolSchema(pool: Pool): Promise<void> {
  await validatePreparedMysqlSchema(pool, async (connection) => {
    await validateMysqlSchema(connection, MYSQL_POOL_TABLES);
    await validateMysqlCredentialFence(connection);
  });
}
