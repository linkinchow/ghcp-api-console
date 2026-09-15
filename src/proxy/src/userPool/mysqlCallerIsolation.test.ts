import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { boundedAdmission } from './admission.js';
import { type PoolConfig, UserPoolError } from './config.js';
import { mysqlCallerGateStats } from './mysqlCallerGate.js';
import { MysqlDeadlineError } from './mysqlDeadline.js';
import { MysqlPoolStore } from './mysqlStore.js';
import type { HeldLease } from './store.js';

const options: PoolConfig = {
  enabled: true, accountDomain: 'example.test', idleTarget: 1, maxAccounts: 2,
  leaseSeconds: 60, provisionalSeconds: 10, pollMs: 1000, retryAfterSeconds: 1,
  warmupModel: 'test-model', requestTimeoutMs: 120000,
};
const caller = (id: number) => `sha256:${id.toString(16).padStart(64, '0')}`;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const exhausted = (error: unknown) => error instanceof UserPoolError && error.code === 'pool_exhausted';
const noTickets = (db: Pool) => assert.deepEqual(mysqlCallerGateStats(db), { retainedTickets: 0, scopes: 0, active: 0, queued: 0 });

/** Each acquisition owns a distinct fake socket, with controllable driver and SQL phases. */
function fixture(ready = false) {
  const calls = { acquisitions: 0, live: 0, maxLive: 0, released: 0, destroyed: 0,
    sql: [] as { socket: number; sql: string }[], order: [] as string[] };
  const sockets: PoolConnection[] = [];
  const hooks: {
    acquire?: (socket: PoolConnection, id: number) => Promise<PoolConnection>;
    query?: (sql: string, id: number) => Promise<void>;
  } = {};
  const rawPool = {
    getConnection() {
      const id = ++calls.acquisitions;
      calls.live++;
      calls.maxLive = Math.max(calls.maxLive, calls.live);
      let disposed = false;
      const dispose = (kind: 'released' | 'destroyed') => {
        assert.equal(disposed, false, `socket ${id} disposed more than once`);
        disposed = true;
        calls[kind]++;
        calls.live--;
        calls.order.push(`${id}:${kind}`);
      };
      const query = async (sql: string) => {
        assert.equal(disposed, false, `SQL on disposed socket ${id}`);
        calls.sql.push({ socket: id, sql });
        calls.order.push(`${id}:${sql}`);
        await hooks.query?.(sql, id);
        if (sql.includes('DATABASE()')) return [[{ name: 'synthetic_db' }]];
        if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
        if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
        if (sql.startsWith('SELECT TIMESTAMPDIFF')) return [[{ now: 1800000000000 }]];
        if (sql.includes('SELECT id FROM user_pool_settings')) return [[{ id: 1 }]];
        if (ready && sql.includes('SELECT * FROM user_pool_leases WHERE caller_id=')) return [[{
          caller_id: caller(1), member_identity: 'member', lease_id: 'lease', phase: 'active',
          assigned_at: 1800000000000, last_success_at: 1800000000000, expires_at: 1800003600000,
        }]];
        if (ready && sql.includes('FROM proxy_accounts WHERE identity=')) return [[{
          identity: 'member', copilot_oauth_status: 'valid', copilot_oauth_token: 'synthetic-token',
        }]];
        if (ready && sql.includes('SELECT * FROM user_pool_accounts WHERE identity=')) return [[{
          identity: 'member', state: 'ready', verified_at: 1800000000000, generation: 1,
        }]];
        if (sql.includes('MAX(id)')) return [[{ n: -9999 }]];
        if (sql.includes('SELECT 1 FROM user_pool_holds')) return [[{ 1: 1 }]];
        if (sql.trimStart().startsWith('SELECT')) return [[]];
        return [{ affectedRows: 1 }];
      };
      const socket = {
        query, execute: query,
        beginTransaction: () => query('BEGIN'),
        commit: () => query('COMMIT'),
        rollback: () => query('ROLLBACK'),
        release: () => dispose('released'), destroy: () => dispose('destroyed'),
      } as unknown as PoolConnection;
      sockets.push(socket);
      return hooks.acquire?.(socket, id) ?? Promise.resolve(socket);
    },
  };
  const pool = rawPool as unknown as Pool;
  const store = (patch: Partial<PoolConfig> = {}, wrapper = pool) => new MysqlPoolStore(wrapper, { ...options, ...patch });
  return { calls, hooks, pool, store, sockets };
}

test('hot caller stays outside driver acquisition; many wrappers share catalog/inference FIFO while B proceeds', async () => {
  const f = fixture();
  const blocked = deferred<void>();
  f.hooks.query = async (sql, id) => { if (id === 1 && sql.includes('GET_LOCK')) await blocked.promise; };
  const order: number[] = [];
  const first = assert.rejects(f.store().acquire(caller(1)), exhausted);
  await tick();
  const pending = Array.from({ length: 24 }, (_, index) => {
    const wrapper = { pool: f.pool, getConnection: f.pool.getConnection.bind(f.pool) } as unknown as Pool;
    const store = f.store({}, wrapper);
    return assert.rejects(index % 2 ? store.acquire(caller(1)) : store.acquireCatalog(caller(1)), exhausted)
      .then(() => { order.push(index); });
  });
  await tick();
  assert.equal(f.calls.acquisitions, 1);
  assert.equal(mysqlCallerGateStats(f.pool).queued, 24);
  await assert.rejects(f.store().acquire(caller(2)), exhausted);
  assert.equal(f.calls.acquisitions, 2);
  blocked.resolve();
  await Promise.all([first, ...pending]);
  assert.deepEqual(order, Array.from({ length: 24 }, (_, index) => index));
  assert.equal(f.calls.maxLive, 2);
  assert.equal(f.calls.acquisitions, f.calls.released);
  noTickets(f.pool);
});

test('33 retained tickets per caller reject overflow before getConnection and queued cancel never acquires', async () => {
  const f = fixture();
  const blocked = deferred<void>();
  f.hooks.query = async (sql, id) => { if (id === 1 && sql.includes('GET_LOCK')) await blocked.promise; };
  const first = assert.rejects(f.store().acquire(caller(1)), exhausted);
  await tick();
  const controllers = Array.from({ length: 32 }, () => new AbortController());
  const pending = controllers.map((controller, index) => assert.rejects(index % 2
    ? f.store().acquire(caller(1), controller.signal) : f.store().acquireCatalog(caller(1), controller.signal),
  error => error === controller.signal.reason));
  await assert.rejects(f.store().acquire(caller(1)), error => error instanceof UserPoolError
    && error.status === 503 && error.code === 'pool_storage_unavailable' && error.retryAfter === 1);
  controllers.forEach(controller => controller.abort());
  await Promise.all(pending);
  assert.equal(f.calls.acquisitions, 1);
  assert.equal(mysqlCallerGateStats(f.pool).queued, 0);
  blocked.resolve();
  await first;
  noTickets(f.pool);
});

for (const mode of ['abort', 'expire'] as const) {
  test(`${mode} during getConnection retains caller head until late socket disposal, with no SQL`, async () => {
    const f = fixture();
    const queued = deferred<PoolConnection>();
    f.hooks.acquire = async (socket, id) => id === 1 ? queued.promise : socket;
    const controller = new AbortController();
    const first = assert.rejects(f.store({ requestTimeoutMs: mode === 'expire' ? 30 : 1000 })
      .acquire(caller(1), controller.signal), error => mode === 'expire'
      ? error instanceof MysqlDeadlineError : error === controller.signal.reason);
    await tick();
    const second = assert.rejects(f.store().acquireCatalog(caller(1)), exhausted);
    if (mode === 'abort') controller.abort();
    await first;
    assert.equal(f.calls.acquisitions, 1);
    assert.equal(f.calls.sql.length, 0);
    assert.equal(mysqlCallerGateStats(f.pool).retainedTickets, 2);
    await assert.rejects(f.store().acquire(caller(2)), exhausted);
    assert.equal(f.calls.acquisitions, 2);
    queued.resolve(f.sockets[0]);
    await second;
    assert.equal(f.calls.sql.filter(call => call.socket === 1).length, 0);
    assert.equal(f.calls.order.indexOf('1:released') < f.calls.order.findIndex(call => call.startsWith('3:')), true);
    assert.equal(f.calls.released, 3);
    noTickets(f.pool);
  });
}

test('late acquisition rejection releases retained head and is observed after cancellation', async () => {
  const f = fixture();
  const queued = deferred<PoolConnection>();
  f.hooks.acquire = async (socket, id) => {
    if (id !== 1) return socket;
    try { return await queued.promise; } finally { socket.destroy(); }
  };
  const controller = new AbortController();
  const first = assert.rejects(f.store().acquire(caller(1), controller.signal), error => error === controller.signal.reason);
  await tick();
  controller.abort();
  await first;
  const second = assert.rejects(f.store().acquire(caller(1)), exhausted);
  queued.reject(new Error('late driver rejection'));
  await second;
  assert.equal(f.calls.sql.some(call => call.socket === 1), false);
  noTickets(f.pool);
});

test('signal abort racing driver fulfillment releases late connection without starting SQL', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.hooks.acquire = async socket => { queueMicrotask(() => controller.abort()); return socket; };
  await assert.rejects(f.store().acquire(caller(1), controller.signal), error => error === controller.signal.reason);
  await tick();
  assert.equal(f.calls.sql.length, 0);
  assert.equal(f.calls.released, 1);
  noTickets(f.pool);
});

test('original five-second deadline includes local queue, driver wait and SQL rather than resetting', async () => {
  const f = fixture();
  const head = deferred<void>();
  f.hooks.query = async (sql, id) => {
    if (id === 1 && sql.includes('GET_LOCK')) await head.promise;
    if (id === 2 && sql.includes('GET_LOCK')) await new Promise(() => {});
  };
  const first = assert.rejects(f.store().acquire(caller(1)), exhausted);
  await tick();
  const started = performance.now();
  const second = assert.rejects(f.store().acquireCatalog(caller(1)), MysqlDeadlineError);
  await sleep(1200);
  head.resolve();
  await first;
  await second;
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 4800 && elapsed < 5900, `original five-second cap, elapsed=${elapsed}`);
  assert.equal(f.calls.acquisitions, 2);
  assert.equal(f.calls.destroyed, 1);
  noTickets(f.pool);
});

test('local queue time consumes a shorter request budget before late driver acquisition disposal', async () => {
  const f = fixture();
  const head = deferred<void>();
  const driver = deferred<PoolConnection>();
  f.hooks.query = async (sql, id) => { if (id === 1 && sql.includes('GET_LOCK')) await head.promise; };
  f.hooks.acquire = async (socket, id) => id === 2 ? driver.promise : socket;
  const first = assert.rejects(f.store().acquire(caller(1)), exhausted);
  await tick();
  const started = performance.now();
  const second = assert.rejects(f.store({ requestTimeoutMs: 600 }).acquire(caller(1)), MysqlDeadlineError);
  await sleep(350);
  head.resolve();
  await first;
  await second;
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 550 && elapsed < 900, `shared 600ms budget, elapsed=${elapsed}`);
  assert.equal(f.calls.acquisitions, 2);
  assert.equal(mysqlCallerGateStats(f.pool).retainedTickets, 1, 'timed-out driver head is still retained');
  driver.resolve(f.sockets[1]);
  await tick();
  assert.equal(f.calls.sql.some(call => call.socket === 2), false);
  assert.equal(f.calls.released, 2);
  noTickets(f.pool);
});

test('caller permit spans acknowledged rollback, retry delay, all retries and named-lock release', async () => {
  const f = fixture();
  const rollback = deferred<void>();
  const unlock = deferred<void>();
  f.hooks.query = async (sql, id) => {
    if (id === 1 && sql.includes('UNION SELECT member_identity')) throw Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' });
    if (id === 1 && sql === 'ROLLBACK') await rollback.promise;
    if (id === 2 && sql.includes('RELEASE_LOCK')) await unlock.promise;
  };
  const first = assert.rejects(f.store().acquire(caller(1)), exhausted);
  await tick();
  const second = assert.rejects(f.store().acquireCatalog(caller(1)), exhausted);
  assert.equal(f.calls.acquisitions, 1);
  rollback.resolve();
  await tick();
  assert.equal(f.calls.acquisitions, 1, 'next caller request cannot jump the retry delay');
  await sleep(35);
  assert.equal(f.calls.acquisitions, 2, 'retry reacquires while next request is still queued');
  assert.equal(mysqlCallerGateStats(f.pool).queued, 1);
  unlock.resolve();
  await Promise.all([first, second]);
  assert.equal(f.calls.acquisitions, 3);
  assert.ok(f.calls.order.indexOf('2:released') < f.calls.order.findIndex(entry => entry.startsWith('3:')));
  noTickets(f.pool);
});

test('admission releases permit before inference completion and does not gate heartbeat or worker work', async () => {
  const f = fixture(true);
  const first = await f.store().acquire(caller(1));
  noTickets(f.pool);
  const second = await f.store().acquire(caller(1));
  assert.notEqual(first.request_id, second.request_id);
  assert.equal(first.lease_id, second.lease_id);
  noTickets(f.pool); // Both inference holds remain active; finish has not been called.
  const blocker = deferred<void>();
  f.hooks.query = async (sql, id) => { if (id === 3 && sql.includes('GET_LOCK')) await blocker.promise; };
  const third = f.store().acquireCatalog(caller(1));
  await tick();
  assert.equal(await f.store().heartbeat(first), true);
  assert.equal(await f.store().claimOwner('worker'), true);
  assert.equal(mysqlCallerGateStats(f.pool).active, 1);
  blocker.resolve();
  await third;
  noTickets(f.pool);
});

test('cancel during acknowledged late COMMIT preserves boundedAdmission hold cleanup without replay', async () => {
  const f = fixture(true);
  const committed = deferred<void>();
  const started = deferred<void>();
  f.hooks.query = async (sql, id) => {
    if (id === 1 && sql === 'COMMIT') { started.resolve(); await committed.promise; }
  };
  const controller = new AbortController();
  const cleaned: HeldLease[] = [];
  const admission = assert.rejects(boundedAdmission(() => f.store().acquire(caller(1), controller.signal),
    controller.signal, async held => { cleaned.push(held); }), { code: 'pool_request_timeout' });
  await started.promise;
  controller.abort();
  await admission;
  assert.equal(mysqlCallerGateStats(f.pool).active, 1, 'COMMIT outcome remains pending');
  committed.resolve();
  await tick();
  assert.equal(cleaned.length, 1);
  assert.equal(f.calls.acquisitions, 1);
  assert.equal(f.calls.sql.filter(call => call.sql === 'COMMIT').length, 1);
  assert.equal(f.calls.sql.filter(call => call.sql === 'ROLLBACK').length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  noTickets(f.pool);
});
