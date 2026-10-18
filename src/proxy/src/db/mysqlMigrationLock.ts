import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { leaseMysqlConnection, MysqlDeadline } from '../userPool/mysqlDeadline.js';

const MIGRATION_LOCK = 'ghcp_proxy_schema_migrations';
export const MYSQL_MIGRATION_DEADLINE_MS = 60000;
/** MYSQL_MIGRATION_LOCK_WAIT_SECONDS: how long a replica waits for another replica's migration. */
export const MYSQL_MIGRATION_LOCK_WAIT = { defaultSeconds: 30, minSeconds: 1, maxSeconds: 3600 } as const;
/** The migration itself may use this long after the lock wait; the default total stays 60 s. */
const MIGRATION_WORK_MS = MYSQL_MIGRATION_DEADLINE_MS - MYSQL_MIGRATION_LOCK_WAIT.defaultSeconds * 1000;

export function assertMysqlMigrationLockWait(seconds: number): number {
  const { minSeconds, maxSeconds } = MYSQL_MIGRATION_LOCK_WAIT;
  if (!Number.isInteger(seconds) || seconds < minSeconds || seconds > maxSeconds) {
    throw new Error(`MYSQL_MIGRATION_LOCK_WAIT_SECONDS must be an integer from ${minSeconds} to ${maxSeconds}.`);
  }
  return seconds;
}

/** One budget for acquisition, the lock wait, DDL and lock cleanup. */
export function mysqlMigrationDeadline(lockWaitSeconds: number): MysqlDeadline {
  const budgetMs = assertMysqlMigrationLockWait(lockWaitSeconds) * 1000 + MIGRATION_WORK_MS;
  return new MysqlDeadline(budgetMs, budgetMs, budgetMs);
}

/** One budget includes acquisition, DDL and lock cleanup. Never recycle an uncertain lock owner. */
export async function withMysqlMigrationLock(pool: Pool, migrate: (connection: PoolConnection) => Promise<void>,
  lockWaitSeconds: number = MYSQL_MIGRATION_LOCK_WAIT.defaultSeconds,
  deadline = mysqlMigrationDeadline(lockWaitSeconds)): Promise<void> {
  assertMysqlMigrationLockWait(lockWaitSeconds);
  const lease = await leaseMysqlConnection(pool, deadline);
  const connection = lease.connection;
  let locked = false;
  let failed = false;
  try {
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        'SELECT GET_LOCK(?, ?) AS acquired',
        [MIGRATION_LOCK, lockWaitSeconds],
      );
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
