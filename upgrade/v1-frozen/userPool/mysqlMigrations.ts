import type { Pool, RowDataPacket } from 'mysql2/promise';
import { withMysqlMigrationLock } from '../db/mysqlMigrationLock.js';
import { MYSQL_BASE_TABLES, MYSQL_POOL_TABLES, MYSQL_CREDENTIAL_FENCE_DDL,
  mysqlCreateTable, validateMysqlSchema, validateMysqlCredentialFence } from '../db/mysqlSchema.js';

const MIGRATION_ID = '2026-09-12-user-pool-mysql-v1';

/** Requires the base Proxy migrations first. MySQL DDL auto-commits; every step is restartable. */
export async function runMysqlPoolMigrations(pool: Pool): Promise<void> {
  await withMysqlMigrationLock(pool, async connection => {
    await validateMysqlSchema(connection, MYSQL_BASE_TABLES);
    const [applied] = await connection.query<RowDataPacket[]>('SELECT 1 FROM schema_migrations WHERE id=?', [MIGRATION_ID]);
    await validateMysqlSchema(connection, MYSQL_POOL_TABLES, { allowMissingTables: applied.length === 0 });
    // A previously-installed fence disappearing makes intervening credential changes unknowable.
    // Validate its body before any DDL; never replace an altered or previously installed fence.
    const hasFence = await validateMysqlCredentialFence(connection, applied.length === 0);
    for (const table of MYSQL_POOL_TABLES) await connection.query(mysqlCreateTable(table));
    if (!hasFence) await connection.query(MYSQL_CREDENTIAL_FENCE_DDL);
    await validateMysqlSchema(connection, MYSQL_POOL_TABLES);
    await validateMysqlCredentialFence(connection);
    await connection.execute('INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES (?, UTC_TIMESTAMP(3))', [MIGRATION_ID]);
  });
}
