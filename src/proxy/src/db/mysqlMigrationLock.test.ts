import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { MysqlDeadline, MysqlDeadlineError } from '../userPool/mysqlDeadline.js';
import { DEFAULT_ENTERPRISE_ID } from '@ghcp/shared';
import {
  assertMysqlMigrationLockWait,
  MYSQL_MIGRATION_DEADLINE_MS,
  MYSQL_MIGRATION_LOCK_WAIT,
  mysqlMigrationDeadline,
  withMysqlMigrationLock,
} from './mysqlMigrationLock.js';
import { runMysqlMigrations } from './mysqlMigrations.js';
import { runMysqlPoolMigrations } from '../userPool/mysqlMigrations.js';
import type { PoolConfig } from '../userPool/config.js';

const seed = { id: DEFAULT_ENTERPRISE_ID, fingerprint: 'f'.repeat(64), maxAccounts: 8 };
const poolOptions: PoolConfig = {
  enabled: true, accountDomain: 'synthetic.example.test', idleTarget: 1, maxAccounts: 8, leaseSeconds: 3600,
  provisionalSeconds: 300, pollMs: 5000, prewarmConcurrency: 2, retryAfterSeconds: 30, warmupModel: 'synthetic',
  requestTimeoutMs: 1000,
};

function fixture() {
  const calls = { queries: [] as string[], values: [] as unknown[], destroyed: 0, released: 0 };
  const raw = {
    async query(sql: string, values?: unknown): Promise<unknown[]> {
      calls.queries.push(sql);
      calls.values.push(values);
      return [[sql.includes('GET_LOCK') ? { acquired: 1 } : { released: 1 }]];
    },
    async execute(): Promise<unknown[]> { return []; },
    destroy() { calls.destroyed++; }, release() { calls.released++; },
  };
  const pool = { getConnection: async () => raw as unknown as PoolConnection } as Pool;
  const run = (ddl: (c: PoolConnection) => Promise<void> = async c => { await c.query('CREATE TABLE synthetic (id INT)'); }) =>
    withMysqlMigrationLock(pool, ddl, MYSQL_MIGRATION_LOCK_WAIT.defaultSeconds, new MysqlDeadline(40, 40));
  return { raw, pool, calls, run };
}
const never = (): Promise<never> => new Promise(() => {});
const tick = () => new Promise(resolve => setImmediate(resolve));

test('base and pool migration entrypoints share the bounded migration acquisition', async t => {
  assert.equal(MYSQL_MIGRATION_DEADLINE_MS, 60000);
  const operations: string[] = [];
  t.mock.method(MysqlDeadline.prototype, 'run', function (operation: string) {
    operations.push(operation);
    return Promise.reject(new MysqlDeadlineError(operation));
  });
  const pool = { getConnection() { assert.fail('deadline must precede acquisition'); } } as unknown as Pool;
  await assert.rejects(runMysqlMigrations(pool, seed), MysqlDeadlineError);
  await assert.rejects(runMysqlPoolMigrations(pool, poolOptions), MysqlDeadlineError);
  assert.deepEqual(operations, ['getConnection', 'getConnection']);
});

test('migration acquisition times out and disposes a late unused connection', async () => {
  const f = fixture();
  let resolve!: (connection: PoolConnection) => void;
  f.pool.getConnection = () => new Promise(yes => { resolve = yes; });
  await assert.rejects(f.run(), MysqlDeadlineError);
  resolve(f.raw as unknown as PoolConnection);
  await tick();
  assert.equal(f.calls.released, 1);
  assert.equal(f.calls.destroyed, 0);
  assert.deepEqual(f.calls.queries, []);
});

for (const phase of ['GET_LOCK', 'CREATE TABLE', 'RELEASE_LOCK']) test(`migration ${phase} timeout destroys without recycling`, async () => {
  const f = fixture();
  const query = f.raw.query;
  f.raw.query = async sql => sql.includes(phase) ? never() : query(sql);
  await assert.rejects(f.run(), MysqlDeadlineError);
  assert.equal(f.calls.destroyed, 1);
  assert.equal(f.calls.released, 0);
});

test('migration execute uses the same deadline and stops late DDL continuation', async () => {
  const f = fixture();
  let resolve!: (result: unknown[]) => void;
  f.raw.execute = () => new Promise(yes => { resolve = yes; });
  await assert.rejects(f.run(async c => {
    await c.execute('INSERT INTO schema_migrations VALUES (?)', ['synthetic']);
    assert.fail('late SQL must not continue migration');
  }), MysqlDeadlineError);
  resolve([]);
  await tick();
  assert.equal(f.calls.destroyed, 1);
  assert.equal(f.calls.released, 0);
});

for (const phase of ['GET_LOCK', 'RELEASE_LOCK']) {
  for (const outcome of ['throw', 'null', 'missing', 'zero']) test(`migration ${phase} ${outcome} cleans up safely`, async () => {
    const f = fixture();
    const query = f.raw.query;
    f.raw.query = async sql => {
      if (!sql.includes(phase)) return query(sql);
      if (outcome === 'throw') throw new Error('synthetic lost lock response');
      return [outcome === 'missing' ? [] : [{ [phase === 'GET_LOCK' ? 'acquired' : 'released']: outcome === 'null' ? null : 0 }]];
    };
    await assert.rejects(f.run(), /lock/);
    const safeUnacquired = phase === 'GET_LOCK' && outcome === 'zero';
    assert.equal(f.calls.destroyed, safeUnacquired ? 0 : 1);
    assert.equal(f.calls.released, safeUnacquired ? 1 : 0);
    if (phase === 'GET_LOCK') assert.deepEqual(f.calls.queries, []);
  });
}

test('DDL error releases an acknowledged lock; cleanup failure never masks original error', async () => {
  for (const failRelease of [false, true]) {
    const f = fixture();
    const query = f.raw.query;
    f.raw.query = async sql => {
      if (failRelease && sql.includes('RELEASE_LOCK')) throw new Error('synthetic cleanup error');
      return query(sql);
    };
    const original = new Error('synthetic DDL error');
    await assert.rejects(f.run(async () => { throw original; }), error => error === original);
    assert.equal(f.calls.destroyed, Number(failRelease));
    assert.equal(f.calls.released, Number(!failRelease));
  }
});

test('successful migration acknowledges lock release before recycling', async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.calls.destroyed, 0);
  assert.equal(f.calls.released, 1);
  assert.match(f.calls.queries.at(-1)!, /RELEASE_LOCK/);
});

test('MYSQL_MIGRATION_LOCK_WAIT_SECONDS bounds GET_LOCK and extends the migration budget', async t => {
  const f = fixture();
  await withMysqlMigrationLock(f.pool, async () => {}, 300);
  assert.match(f.calls.queries[0], /GET_LOCK\(\?, \?\)/);
  assert.deepEqual(f.calls.values[0], ['ghcp_proxy_schema_migrations', 300]);
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const long = mysqlMigrationDeadline(300);
  now = 329_000;
  assert.equal(await long.run('synthetic', async () => 'in time'), 'in time');
  now = 330_001;
  await assert.rejects(long.run('synthetic', async () => 'late'), MysqlDeadlineError);
  // The default wait keeps the previous 60 s total budget.
  now = 0;
  const standard = mysqlMigrationDeadline(MYSQL_MIGRATION_LOCK_WAIT.defaultSeconds);
  now = MYSQL_MIGRATION_DEADLINE_MS + 1;
  await assert.rejects(standard.run('synthetic', async () => 'late'), MysqlDeadlineError);
});

test('the lock wait must be an integer number of seconds within bounds', async () => {
  assert.equal(MYSQL_MIGRATION_LOCK_WAIT.defaultSeconds, 30);
  for (const invalid of [0, -1, 1.5, Number.NaN, 3601]) {
    assert.throws(() => assertMysqlMigrationLockWait(invalid), /MYSQL_MIGRATION_LOCK_WAIT_SECONDS/);
  }
  assert.equal(assertMysqlMigrationLockWait(3600), 3600);
  const f = fixture();
  await assert.rejects(withMysqlMigrationLock(f.pool, async () => {}, 0), /MYSQL_MIGRATION_LOCK_WAIT_SECONDS/);
  assert.deepEqual(f.calls.queries, []);
});
