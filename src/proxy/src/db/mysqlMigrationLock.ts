import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { leaseMysqlConnection, MysqlDeadline } from '../userPool/mysqlDeadline.js';

const MIGRATION_LOCK = 'ghcp_proxy_schema_migrations';
export const MYSQL_MIGRATION_DEADLINE_MS = 60000;

/** One budget includes acquisition, DDL and lock cleanup. Never recycle an uncertain lock owner. */
export async function withMysqlMigrationLock(pool: Pool, migrate: (connection: PoolConnection) => Promise<void>,
  deadline = new MysqlDeadline(MYSQL_MIGRATION_DEADLINE_MS, MYSQL_MIGRATION_DEADLINE_MS)): Promise<void> {
  const lease = await leaseMysqlConnection(pool, deadline);
  const connection = lease.connection;
  let locked = false;
  let failed = false;
  try {
    try {
      const [rows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, 30) AS acquired', [MIGRATION_LOCK]);
      locked = Number(rows[0]?.acquired) === 1;
      if (!locked && rows[0]?.acquired !== 0 && rows[0]?.acquired !== '0') {
        throw new Error('Uncertain MySQL schema migration lock acquisition.');
      }
    } catch (error) {
      lease.destroy(); // A lost GET_LOCK response can hide a connection-scoped lock.
      throw error;
    }
    if (!locked) throw new Error('Timed out waiting for the Proxy MySQL schema migration lock.');
    await migrate(connection);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      if (locked && !lease.destroyed) {
        try {
          const [rows] = await connection.query<RowDataPacket[]>('SELECT RELEASE_LOCK(?) AS released', [MIGRATION_LOCK]);
          if (Number(rows[0]?.released) !== 1) throw new Error('Unconfirmed MySQL schema migration lock release.');
        } catch (error) {
          lease.destroy();
          if (!failed) throw error; // Preserve the original migration/timeout failure.
        }
      }
    } finally {
      lease.release(); // A destroyed lease is deliberately not returned to the pool.
    }
  }
}
