import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { PoolConfig } from './config.js';
import {
  isMysqlStorageUnavailable, leaseMysqlConnection, MysqlConnectionError, MysqlDeadline, MysqlDeadlineError, MYSQL_POOL_DEADLINE_MS,
} from './mysqlDeadline.js';
import { MysqlPoolStore } from './mysqlStore.js';

const options: PoolConfig = {
  enabled: true, accountDomain: 'example.test', idleTarget: 1, maxAccounts: 2,
  leaseSeconds: 60, provisionalSeconds: 10, pollMs: 1000, retryAfterSeconds: 1,
  warmupModel: 'test-model', requestTimeoutMs: 500,
};
const never = <T>(): Promise<T> => new Promise(() => {});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const calls = { acquisitions: 0, queries: [] as string[], commits: 0, rollbacks: 0, destroyed: 0, released: 0 };
  const raw = {
    async query(sql: string): Promise<unknown[]> {
      calls.queries.push(sql);
      if (sql.includes('SELECT id FROM user_pool_settings')) return [[{ id: 1 }]];
      if (sql.startsWith('SELECT') && sql.includes('TIMESTAMPDIFF')) return [[{ now: '1800000000000' }]];
      if (sql.includes('MAX(id)')) return [[{ n: -9999 }]];
      if (sql.startsWith('SELECT')) return [[]];
      return [{ affectedRows: 1 }];
    },
    async execute(): Promise<unknown[]> { return [{ affectedRows: 1 }]; },
    async beginTransaction() {},
    async commit() { calls.commits++; },
    async rollback() { calls.rollbacks++; },
    destroy() { calls.destroyed++; },
    release() { calls.released++; },
  };
  const pool = {
    async getConnection() { calls.acquisitions++; return raw as unknown as PoolConnection; },
    query() { assert.fail('must not execute through the Pool'); },
    execute() { assert.fail('must not execute through the Pool'); },
    destroy() { assert.fail('must never destroy the Pool'); },
    end() { assert.fail('must never close the Pool'); },
  };
  return { calls, raw, pool, store: new MysqlPoolStore(pool as unknown as Pool, options) };
}
const deadlock = () => Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' });
const connectionFailure = (code = 'ECONNRESET') => Object.assign(
  new Error(`${code}: private-db.example.test:3306; password=not-for-clients`), { code });
function assertConnectionFailure(cause: unknown): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof MysqlConnectionError);
    assert.equal(error.cause, cause);
    assert.equal(error.code, 'POOL_SQL_UNAVAILABLE');
    assert.equal(error.message, 'User pool MySQL storage is unavailable');
    assert.equal(isMysqlStorageUnavailable(error), true);
    return true;
  };
}

for (const mode of ['sync', 'async'] as const) {
  test(`${mode} driver acquisition connectivity errors are tagged without acquiring or disposing a socket`, async () => {
    for (const code of [
      'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE',
      'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
      'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'PROTOCOL_ENQUEUE_AFTER_QUIT',
      'ER_CON_COUNT_ERROR', 'ER_SERVER_SHUTDOWN',
    ]) {
      const f = fixture();
      const cause = connectionFailure(code);
      f.pool.getConnection = function () {
        assert.equal(this, f.pool);
        f.calls.acquisitions++;
        if (mode === 'sync') throw cause;
        return Promise.reject(cause);
      };
      await assert.rejects(f.store.claimOwner('owner'), assertConnectionFailure(cause));
      assert.equal(f.calls.acquisitions, 1);
      assert.equal(f.calls.queries.length, 0);
      assert.equal(f.calls.destroyed, 0);
      assert.equal(f.calls.released, 0);
    }
  });

  for (const method of ['query', 'execute', 'beginTransaction', 'commit', 'rollback'] as const) {
    test(`${mode} driver ${method} connectivity failure destroys only the leased socket before rejection`, async () => {
      const f = fixture();
      const cause = connectionFailure();
      let attempts = 0;
      Object.assign(f.raw, { [method]: function () {
        assert.equal(this, f.raw);
        attempts++;
        if (mode === 'sync') throw cause;
        return Promise.reject(cause);
      } });
      const lease = await leaseMysqlConnection(f.pool, new MysqlDeadline());
      await assert.rejects(Reflect.apply(lease.connection[method], lease.connection, ['SELECT 1']), assertConnectionFailure(cause));
      assert.equal(lease.destroyed, true);
      assert.equal(f.calls.destroyed, 1);
      lease.release();
      lease.destroy();
      await assert.rejects(Reflect.apply(lease.connection[method], lease.connection, ['SELECT 1']), /closed/);
      assert.equal(attempts, 1);
      assert.equal(f.calls.acquisitions, 1);
      assert.equal(f.calls.destroyed, 1);
      assert.equal(f.calls.released, 0);
    });
  }

  test(`${mode} mysql2 queue-limit errors are tagged only at connection acquisition`, async () => {
    const cause = new Error('Queue limit reached.');
    const fail = () => { if (mode === 'sync') throw cause; return Promise.reject(cause); };
    const f = fixture();
    f.pool.getConnection = fail;
    await assert.rejects(leaseMysqlConnection(f.pool, new MysqlDeadline()), assertConnectionFailure(cause));
    assert.equal(f.calls.destroyed, 0);
    const sql = fixture();
    sql.raw.query = fail;
    await assert.rejects(sql.store.events(), error => error === cause);
    assert.equal(sql.calls.destroyed, 0);
    assert.equal(sql.calls.released, 1);
    await assert.rejects(new MysqlDeadline().run('application', fail), error => error === cause);
    assert.equal(isMysqlStorageUnavailable(cause), false);
  });

  test(`${mode} generic driver errors retain their identity and do not poison a lease`, async () => {
    for (const cause of [
      new Error('application failure'),
      Object.assign(new Error('syntax failure'), { code: 'ER_PARSE_ERROR' }),
      Object.assign(new Error('constraint failure'), { code: 'ER_DUP_ENTRY' }),
      Object.assign(new Error('unknown fatal failure'), { code: 'UNRECOGNIZED', fatal: true }),
      deadlock(),
    ]) {
      const fail = () => { if (mode === 'sync') throw cause; return Promise.reject(cause); };
      const f = fixture();
      f.pool.getConnection = fail;
      await assert.rejects(leaseMysqlConnection(f.pool, new MysqlDeadline()), (error) => error === cause);
      assert.equal(f.calls.destroyed, 0);
      assert.equal(f.calls.released, 0);
      const leased = fixture();
      leased.raw.query = fail;
      await assert.rejects(leased.store.events(), (error) => error === cause);
      assert.equal(leased.calls.destroyed, 0);
      assert.equal(leased.calls.released, 1);
      assert.equal(isMysqlStorageUnavailable(cause), false);
    }
  });
}

test('an application or upstream connectivity error outside the driver boundary is not tagged', async () => {
  const cause = connectionFailure();
  await assert.rejects(new MysqlDeadline().run('application', async () => { throw cause; }), (error) => error === cause);
  assert.equal(isMysqlStorageUnavailable(cause), false);
  assert.equal(isMysqlStorageUnavailable(new Error('MysqlConnectionError')), false);
  assert.equal(isMysqlStorageUnavailable(new MysqlDeadlineError('query')), true);
});

test('driver failure cause survives even if socket destruction throws', async () => {
  const f = fixture();
  const cause = connectionFailure();
  f.raw.query = async () => { throw cause; };
  f.raw.destroy = () => { f.calls.destroyed++; throw new Error('already closed'); };
  await assert.rejects(f.store.events(), assertConnectionFailure(cause));
  assert.equal(f.calls.destroyed, 1);
  assert.equal(f.calls.released, 0);
});

for (const phase of ['isolation', 'begin', 'mutation', 'commit'] as const) {
  test(`transaction ${phase} connectivity failure destroys its lease without rollback or replay`, async () => {
    const f = fixture();
    const cause = connectionFailure();
    const query = f.raw.query.bind(f.raw);
    f.raw.query = async (sql) => {
      if ((phase === 'isolation' && sql.startsWith('SET TRANSACTION'))
        || (phase === 'mutation' && sql.startsWith('UPDATE user_pool_settings'))) throw cause;
      return query(sql);
    };
    if (phase === 'begin') f.raw.beginTransaction = async () => { throw cause; };
    if (phase === 'commit') f.raw.commit = async () => { f.calls.commits++; throw cause; };
    await assert.rejects(f.store.claimOwner('owner'), assertConnectionFailure(cause));
    assert.equal(f.calls.acquisitions, 1);
    assert.equal(f.calls.destroyed, 1);
    assert.equal(f.calls.released, 0);
    assert.equal(f.calls.rollbacks, 0);
    assert.equal(f.calls.commits, phase === 'commit' ? 1 : 0);
  });
}

test('rollback connectivity failure cannot replay a known lock error', async () => {
  const f = fixture();
  const cause = deadlock();
  const query = f.raw.query.bind(f.raw);
  f.raw.query = async (sql) => {
    if (sql.includes('FOR UPDATE')) throw cause;
    return query(sql);
  };
  f.raw.rollback = async () => { f.calls.rollbacks++; throw connectionFailure(); };
  await assert.rejects(f.store.claimOwner('owner'), (error) => error === cause);
  assert.equal(f.calls.acquisitions, 1);
  assert.equal(f.calls.rollbacks, 1);
  assert.equal(f.calls.commits, 0);
  assert.equal(f.calls.destroyed, 1);
  assert.equal(f.calls.released, 0);
});

test('SQL default cap stays local, without adding persisted configuration fields', () => {
  assert.equal(MYSQL_POOL_DEADLINE_MS, 5000);
  const config = { ...options };
  new MysqlPoolStore(fixture().pool as unknown as Pool, config);
  assert.deepEqual(config, options);
});

test('deadline does not start remote work after budget exhaustion', async () => {
  await assert.rejects(new MysqlDeadline(0).run('query', () => {
    assert.fail('expired work must not start');
  }), MysqlDeadlineError);
});

test('acquisition timeout releases a late unused connection without queries or pool destruction', async () => {
  const f = fixture();
  const pending = deferred<PoolConnection>();
  f.pool.getConnection = () => { f.calls.acquisitions++; return pending.promise; };
  await assert.rejects(f.store.claimOwner('owner'), MysqlDeadlineError);
  assert.equal(f.calls.destroyed, 0);
  pending.resolve(f.raw as unknown as PoolConnection);
  await tick();
  assert.equal(f.calls.released, 1);
  assert.equal(f.calls.acquisitions, 1);
  assert.equal(f.calls.queries.length, 0);
});

test('late failed acquisition is observed after timeout', async () => {
  const f = fixture();
  const pending = deferred<PoolConnection>();
  f.pool.getConnection = () => pending.promise;
  await assert.rejects(f.store.events(), MysqlDeadlineError);
  pending.reject(new Error('late connection failure'));
  await tick();
  assert.equal(f.calls.destroyed, 0);
});

test('nontransaction reads destroy the actual leased connection when query stalls', async () => {
  const f = fixture();
  f.raw.query = () => never();
  await assert.rejects(f.store.events(), MysqlDeadlineError);
  assert.equal(f.calls.acquisitions, 1);
  assert.equal(f.calls.destroyed, 1);
  assert.equal(f.calls.released, 0);
  assert.equal(f.calls.commits, 0);
});

test('multi-query reads use one connection and a shared deadline', async () => {
  const f = fixture();
  const query = f.raw.query.bind(f.raw);
  f.raw.query = async (sql) => sql.includes('TIMESTAMPDIFF') ? query(sql) : never();
  await assert.rejects(f.store.accounts(), MysqlDeadlineError);
  assert.equal(f.calls.acquisitions, 1);
  assert.equal(f.calls.destroyed, 1);
});

test('successful reads release their connection and preserve numeric normalization', async () => {
  const f = fixture();
  assert.equal(await f.store.now(), 1800000000000);
  assert.equal(f.calls.released, 1);
  assert.equal(f.calls.destroyed, 0);
});

for (const phase of ['isolation', 'begin', 'gate', 'mutation', 'commit'] as const) {
  test(`transaction ${phase} timeout destroys its connection without replay or late commit`, async () => {
    const f = fixture();
    const pending = deferred<unknown[]>();
    const query = f.raw.query.bind(f.raw);
    f.raw.query = async (sql) => {
      if ((phase === 'isolation' && sql.startsWith('SET TRANSACTION'))
        || (phase === 'gate' && sql.includes('FOR UPDATE'))
        || (phase === 'mutation' && sql.startsWith('UPDATE user_pool_settings'))) return pending.promise;
      return query(sql);
    };
    if (phase === 'begin') f.raw.beginTransaction = async () => { await pending.promise; };
    if (phase === 'commit') f.raw.commit = async () => { f.calls.commits++; await pending.promise; };
    await assert.rejects(f.store.claimOwner('owner'), MysqlDeadlineError);
    assert.equal(f.calls.acquisitions, 1);
    assert.equal(f.calls.destroyed, 1);
    assert.equal(f.calls.released, 0);
    assert.equal(f.calls.rollbacks, 0);
    assert.equal(f.calls.commits, phase === 'commit' ? 1 : 0);
    pending.resolve([{ affectedRows: 1 }]);
    await tick();
    assert.equal(f.calls.commits, phase === 'commit' ? 1 : 0, 'late statement must not continue the transaction');
    assert.equal(f.calls.destroyed, 1);
  });
}

test('rollback timeout destroys connection and cannot replay even a known lock error', async () => {
  const f = fixture();
  const query = f.raw.query.bind(f.raw);
  f.raw.query = async (sql) => {
    if (sql.includes('FOR UPDATE')) throw deadlock();
    return query(sql);
  };
  f.raw.rollback = async () => { f.calls.rollbacks++; await never(); };
  await assert.rejects(f.store.claimOwner('owner'), /deadlock/);
  assert.equal(f.calls.acquisitions, 1);
  assert.equal(f.calls.rollbacks, 1);
  assert.equal(f.calls.destroyed, 1);
  assert.equal(f.calls.released, 0);
});

test('acknowledged rollback of a lock error permits bounded retry with a new lease', async () => {
  const f = fixture();
  const query = f.raw.query.bind(f.raw);
  f.raw.query = async (sql) => {
    if (f.calls.acquisitions === 1 && sql.includes('FOR UPDATE')) throw deadlock();
    return query(sql);
  };
  const store = new MysqlPoolStore(f.pool as unknown as Pool, { ...options, requestTimeoutMs: 1000 });
  assert.equal(await store.claimOwner('owner'), true);
  assert.equal(f.calls.acquisitions, 2);
  assert.equal(f.calls.rollbacks, 1);
  assert.equal(f.calls.commits, 1);
  assert.equal(f.calls.released, 2);
});

test('shared budget includes acquisition and all queries rather than resetting per statement', async () => {
  const f = fixture();
  const pending = deferred<PoolConnection>();
  f.pool.getConnection = () => pending.promise;
  const leasePromise = leaseMysqlConnection(f.pool, new MysqlDeadline(1000));
  await new Promise((resolve) => setTimeout(resolve, 20));
  pending.resolve(f.raw as unknown as PoolConnection);
  const lease = await leasePromise;
  // Acquisition has already consumed part of this operation's budget.
  f.raw.query = () => never();
  await assert.rejects(lease.connection.query('SELECT 1'), MysqlDeadlineError);
  assert.equal(lease.destroyed, true);
  lease.release();
  assert.equal(f.calls.released, 0);
  await assert.rejects(lease.connection.commit(), /closed/);
  assert.equal(f.calls.commits, 0);
});

test('execute is bounded too, and uses the actual driver receiver', async () => {
  const f = fixture();
  f.raw.execute = function () {
    assert.equal(this, f.raw);
    return never();
  };
  const lease = await leaseMysqlConnection(f.pool, new MysqlDeadline(20));
  await assert.rejects(lease.connection.execute('INSERT test'), MysqlDeadlineError);
  assert.equal(f.calls.destroyed, 1);
});

test('socket release failure attempts disposal and retains the original release error', async () => {
  const f = fixture();
  const failure = new Error('release failed');
  f.raw.release = () => { throw failure; };
  const lease = await leaseMysqlConnection(f.pool, new MysqlDeadline());
  assert.throws(() => lease.release(), error => error === failure);
  assert.equal(lease.destroyed, true);
  assert.equal(f.calls.destroyed, 1);
  lease.release();
  lease.destroy();
  assert.equal(f.calls.destroyed, 1);
});

test('ambiguous COMMIT error never replays even after acknowledged rollback', async () => {
  const f = fixture();
  f.raw.commit = async () => { f.calls.commits++; throw deadlock(); };
  await assert.rejects(f.store.claimOwner('owner'), /deadlock/);
  assert.equal(f.calls.acquisitions, 1);
  assert.equal(f.calls.commits, 1);
  assert.equal(f.calls.rollbacks, 1);
  assert.equal(f.calls.destroyed, 1);
  assert.equal(f.calls.released, 0);
});
