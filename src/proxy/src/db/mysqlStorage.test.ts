import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createPool, type Pool, type PoolConnection } from 'mysql2/promise';
import { MysqlStorage } from './mysqlStorage.js';
import { MYSQL_BASE_TABLES } from './mysqlSchema.js';
import { MysqlConnectionError } from '../userPool/mysqlDeadline.js';

const testUrl = 'mysql://test:test@127.0.0.1:1/proxy_test';
const SCHEMA_CHANGING_SQL = /\b(CREATE|ALTER|DROP|RENAME|TRUNCATE|GET_LOCK|INSERT|UPDATE|DELETE)\b/i;

for (const autoMigrate of [undefined, true]) {
  test(`runs migrations when autoMigrate is ${autoMigrate} and does not fall back on failure`, async (t) => {
    const pool = createTestPool(t);
    const denied = new Error('CREATE command denied');
    const migration = t.mock.method(pool, 'getConnection', async () => { throw denied; });
    const query = t.mock.method(pool, 'query', async () => {
      assert.fail('Must not fall back to table checks or ping after a migration failure.');
    });
    const storage = autoMigrate === undefined
      ? new MysqlStorage(pool, 2)
      : new MysqlStorage(pool, 2, autoMigrate);

    await assert.rejects(storage.initialize(), (error) => error === denied);
    assert.equal(migration.mock.callCount(), 1);
    assert.equal(query.mock.callCount(), 0);
  });
}

test('MYSQL_AUTO_MIGRATE=false validates the prepared schema read-only and points to the DBA script', async (t) => {
  const pool = createTestPool(t);
  // Every base table exists except proxy_request_stats.
  const presentTables = MYSQL_BASE_TABLES.filter((name) => name !== 'proxy_request_stats');
  const connection = fakeConnection((sql) => {
    if (/FROM information_schema\.TABLES/i.test(sql)) {
      return presentTables.map((name) => ({ TABLE_NAME: name, ENGINE: 'InnoDB' }));
    }
    // Columns etc. are irrelevant: validation stops at the first table that does not match.
    return [];
  });
  t.mock.method(pool, 'getConnection', async () => connection.raw);

  await assert.rejects(new MysqlStorage(pool, 2, false).initialize(), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /MYSQL_AUTO_MIGRATE=false/);
    assert.match(error.message, /scripts\/proxy-mysql-initial\.sql/);
    assert.ok(error.cause instanceof Error);
    return true;
  });
  assert.ok(connection.statements.length > 0);
  assert.deepEqual(connection.statements.filter((sql) => SCHEMA_CHANGING_SQL.test(sql)), []);
  assert.equal(connection.released(), true);
});

test('MYSQL_AUTO_MIGRATE=false reports an unreachable database as unavailable, not as a schema problem', async (t) => {
  const pool = createTestPool(t);
  const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  t.mock.method(pool, 'getConnection', async () => { throw refused; });

  await assert.rejects(new MysqlStorage(pool, 2, false).initialize(), (error) => {
    assert.ok(error instanceof MysqlConnectionError);
    assert.equal(error.cause, refused);
    return true;
  });
});

function createTestPool(t: TestContext): Pool {
  const pool = createPool(testUrl);
  t.after(() => pool.end());
  t.mock.method(pool, 'getConnection', async () => {
    assert.fail('Unexpected migration connection.');
  });
  t.mock.method(pool, 'execute', async () => {
    assert.fail('Unexpected SQL execution.');
  });
  return pool;
}

/** Minimal stand-in for a mysql2 connection that records every statement it receives. */
function fakeConnection(rowsFor: (sql: string) => unknown[]) {
  const statements: string[] = [];
  let released = false;
  const run = async (sql: string) => {
    statements.push(sql);
    return [rowsFor(sql), []];
  };
  const raw = {
    query: run,
    execute: run,
    release: () => { released = true; },
    destroy: () => { released = true; },
  } as unknown as PoolConnection;
  return { raw, statements, released: () => released };
}
