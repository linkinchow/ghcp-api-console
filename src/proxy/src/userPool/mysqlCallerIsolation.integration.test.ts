import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createConnection, createPool, type Connection, type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import { runMysqlMigrations } from '../db/mysqlMigrations.js';
import type { PoolConfig } from './config.js';
import { MysqlDeadlineError } from './mysqlDeadline.js';
import { MysqlPoolStore } from './mysqlStore.js';
import type { HeldLease } from './store.js';

const options: PoolConfig = {
  enabled: true, accountDomain: 'synthetic.example.test', idleTarget: 2, maxAccounts: 2,
  leaseSeconds: 172800, provisionalSeconds: 300, pollMs: 5000, prewarmConcurrency: 2,
  retryAfterSeconds: 30, warmupModel: 'synthetic-no-http', requestTimeoutMs: 120000,
};
const caller = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;
const lockName = (database: string, id: string) => createHash('sha256').update(JSON.stringify([database, id])).digest('hex');
const mysqlUrl = process.env.MYSQL_TEST_URL;
const enabled = Boolean(mysqlUrl) && process.env.MYSQL_POOL_TEST_DISPOSABLE === '1';

type Outcome<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };
function observe<T>(pending: Promise<T>): Promise<Outcome<T>> {
  // Attach rejection handlers immediately, including requests canceled before we await them.
  return pending.then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
}
function fulfilled<T>(result: Outcome<T>): T {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}
async function within<T>(pending: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), Math.max(1, ms));
    })]);
  } finally { clearTimeout(timer); }
}
async function eventually(check: () => Promise<boolean>, message: string, ms = 1000): Promise<void> {
  const until = performance.now() + ms;
  do {
    if (await check()) return;
    if (performance.now() >= until) break;
    await delay(10);
  } while (performance.now() < until);
  assert.fail(message);
}

/**
 * Real MySQL only; no environment/app/SQLite imports, HTTP, or fake SQL answers.
 * Explicit root loopback opt-in creates/drops a random sibling database. The database
 * named in MYSQL_TEST_URL is NEVER selected or modified. Root observes PROCESSLIST
 * on its own connection, restricted to the exact freshly created database name.
 */
test('MySQL caller isolation: local FIFO protects unrelated callers and shares the SQL deadline', {
  skip: enabled ? false : 'Requires root loopback MYSQL_TEST_URL (ghcp_pool_test_*) and MYSQL_POOL_TEST_DISPOSABLE=1; creates a fresh synthetic database.',
  timeout: 30000,
}, async t => {
  const url = new URL(mysqlUrl!);
  assert.equal(url.protocol, 'mysql:');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Refusing a non-loopback MySQL test server');
  assert.match(url.pathname, /^\/ghcp_pool_test_[a-z0-9_]+$/, 'Refusing a non-test MySQL URL');
  assert.equal(url.search, '', 'Connection overrides are forbidden');
  assert.equal(url.hash, '', 'URL fragments are forbidden');
  assert.equal(decodeURIComponent(url.username), 'root', 'A separate root connection is required for PROCESSLIST observation');
  const database = `ghcp_pool_test_${randomUUID().replaceAll('-', '')}`;
  url.pathname = '/';
  const admin = await createConnection({ uri: url.toString(), connectTimeout: 3000 });
  let db: Pool | undefined;
  let blocker: Connection | undefined;
  let created = false;
  const retained = new Set<PoolConnection>();
  let closing = false;
  const pending: Array<Promise<Outcome<HeldLease>>> = [];
  const admitted: HeldLease[] = [];
  let first: MysqlPoolStore | undefined;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    created = true;
    url.pathname = `/${database}`;
    db = createPool({ uri: url.toString(), connectionLimit: 3, connectTimeout: 3000,
      timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
    blocker = await createConnection({ uri: url.toString(), connectTimeout: 3000 });
    const pool = db;
    const lockConnection = blocker;

    let connectionRequests = 0;
    // Different promise-pool wrappers MUST still share the gate through .pool.
    // Only count real getConnection calls; never intercept queries or fabricate results.
    const countedPool = () => new Proxy(pool, {
      get(target, property) {
        if (property === 'getConnection') return () => { connectionRequests++; return target.getConnection(); };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const firstPool = countedPool(), secondPool = countedPool();
    assert.notEqual(firstPool, secondPool);
    assert.equal(firstPool.pool, secondPool.pool, 'The instrumentation preserves the underlying pool identity');
    first = new MysqlPoolStore(firstPool, options);
    const store = first;
    const second = new MysqlPoolStore(secondPool, options);
    await runMysqlMigrations(pool);
    await store.initialize();
    await second.initialize();

    const start = (owner: MysqlPoolStore, id: string, kind: 'lease' | 'catalog', signal?: AbortSignal) => {
      const outcome = observe(kind === 'catalog' ? owner.acquireCatalog(id, signal) : owner.acquire(id, signal))
        .then(result => { if (result.status === 'fulfilled') admitted.push(result.value); return result; });
      pending.push(outcome);
      return outcome;
    };
    const reset = async () => {
      for (const table of ['user_pool_holds', 'user_pool_catalog_holds', 'user_pool_catalog_cooldowns',
        'user_pool_leases', 'user_pool_accounts', 'user_pool_events', 'proxy_accounts']) await pool.query(`DELETE FROM ${table}`);
      await pool.query('UPDATE user_pool_settings SET next_ordinal=0, owner=NULL, owner_until=0 WHERE id=1');
      for (let i = 0; i < 2; i++) {
        const member = await store.reserve();
        assert.ok(member);
        await pool.execute("UPDATE proxy_accounts SET copilot_oauth_status='valid', copilot_oauth_token='SyntheticToken' WHERE identity=?", [member.identity]);
        await store.update(member.identity, { state: 'ready', stage: 'ready', verified_at: await store.now() });
      }
      connectionRequests = 0;
    };
    const lock = async (id: string) => {
      const [rows] = await lockConnection.query<RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS acquired', [lockName(database, id)]);
      assert.equal(Number(rows[0].acquired), 1);
    };
    const unlock = async (id: string) => {
      const [rows] = await lockConnection.query<RowDataPacket[]>('SELECT RELEASE_LOCK(?) AS released', [lockName(database, id)]);
      assert.equal(Number(rows[0].released), 1);
    };
    const waiters = async (id: string) => {
      const [rows] = await admin.query<RowDataPacket[]>(`SELECT ID AS id, STATE AS state, INFO AS statement
        FROM information_schema.PROCESSLIST WHERE DB=? AND COMMAND<>'Sleep' AND INFO IS NOT NULL`, [database]);
      return rows.filter(row => /^\s*SELECT\s+GET_LOCK\s*\(/i.test(String(row.statement))
        && String(row.statement).includes(lockName(database, id)));
    };
    const assertBlockerOwns = async (id: string) => {
      const [rows] = await admin.query<RowDataPacket[]>('SELECT IS_USED_LOCK(?) AS owner', [lockName(database, id)]);
      assert.equal(Number(rows[0].owner), lockConnection.threadId, 'The external blocker, not a pool request, still owns the lock');
    };
    const persistedHolds = async () => {
      const [rows] = await admin.query<RowDataPacket[]>(`SELECT h.request_id, l.caller_id, l.member_identity, 'lease' AS kind
        FROM \`${database}\`.user_pool_holds h JOIN \`${database}\`.user_pool_leases l ON l.lease_id=h.lease_id
        UNION ALL SELECT request_id, caller_id, member_identity, 'catalog' AS kind FROM \`${database}\`.user_pool_catalog_holds`);
      return rows;
    };
    const assertNoBinding = async (id: string) => {
      const [rows] = await admin.query<RowDataPacket[]>(`SELECT caller_id FROM \`${database}\`.user_pool_leases WHERE caller_id=?
        UNION ALL SELECT caller_id FROM \`${database}\`.user_pool_catalog_holds WHERE caller_id=?
        UNION ALL SELECT caller_id FROM \`${database}\`.user_pool_catalog_cooldowns WHERE caller_id=?`, [id, id, id]);
      assert.equal(rows.length, 0, 'Unadmitted/canceled requests must not create a caller binding');
    };

    await t.test('one SQL waiter for twelve mixed same-caller requests; canceled FIFO entries never borrow a connection; B finishes below 1s', async () => {
      await reset();
      const a = caller(1), b = caller(2);
      await lock(a);
      const began = performance.now();
      const controllers = Array.from({ length: 12 }, () => new AbortController());
      const completed: number[] = [];
      const launch = (i: number) => start(Math.floor(i / 2) % 2 ? second : store, a,
        i % 2 ? 'catalog' : 'lease', controllers[i].signal).then(result => {
        if (result.status === 'fulfilled') completed.push(i);
        return result;
      });
      const requests = [launch(0)];
      await eventually(async () => (await waiters(a)).length === 1, 'The FIFO head never reached the real MySQL GET_LOCK');
      for (let i = 1; i < controllers.length; i++) requests.push(launch(i));
      await delay(25);
      assert.equal(connectionRequests, 1, 'Followers must queue before getConnection, across stores and admission kinds');
      assert.equal((await waiters(a)).length, 1, 'Only the FIFO head may consume a SQL lock waiter');
      await assertBlockerOwns(a);
      await assertNoBinding(a);

      // Both admission kinds on both wrappers are represented among canceled entries.
      const canceled = new Set([2, 3, 4, 5]);
      for (const i of canceled) controllers[i].abort(new Error(`synthetic-queued-cancel-${i}`));
      for (const i of canceled) {
        const result = await within(requests[i], 500, 'A canceled local waiter did not settle promptly');
        assert.equal(result.status, 'rejected');
        if (result.status === 'rejected') assert.equal(result.reason, controllers[i].signal.reason);
      }
      assert.equal(connectionRequests, 1, 'Canceling a follower must not cause a driver acquisition');
      assert.deepEqual(completed, []);

      const bStarted = performance.now();
      const bHeld = fulfilled(await within(start(second, b, 'lease'), 1000, 'Caller B admission was starved by caller A'));
      await within(second.finish(bHeld, false), 1000 - (performance.now() - bStarted), 'Caller B finish was starved by caller A');
      assert.ok(performance.now() - bStarted < 1000, 'Caller B acquire + finish must complete below 1s while A remains blocked');
      await assertBlockerOwns(a);
      assert.equal((await waiters(a)).length, 1);
      assert.equal(connectionRequests, 3, 'Only A head, B admission and B finish may borrow connections while blocked');
      assert.deepEqual(await persistedHolds(), [], 'B finish leaves no hold; queued/canceled A requests create none');
      await assertNoBinding(a);
      assert.ok(performance.now() - began < 4000, 'Release the blocker well before the original 5s admission deadline');
      await unlock(a);

      const results = await within(Promise.all(requests), 3000, 'Surviving A requests did not drain after unlocking');
      const survivors = results.filter((_, i) => !canceled.has(i)).map(fulfilled);
      assert.deepEqual(completed, Array.from({ length: 12 }, (_, i) => i).filter(i => !canceled.has(i)), 'Surviving entries keep FIFO order');
      assert.equal(connectionRequests, survivors.length + 2, 'Canceled entries never reached getConnection, even after the queue drains');
      assert.equal(new Set(survivors.map(h => h.request_id)).size, survivors.length);
      assert.equal(new Set(survivors.map(h => h.member_identity)).size, 1);
      assert.notEqual(survivors[0].member_identity, bHeld.member_identity);
      const inference = survivors.filter(h => h.kind === 'lease');
      assert.equal(inference.length, 4);
      assert.equal(new Set(inference.map(h => h.lease_id)).size, 1);
      assert.equal(new Set(inference.map(h => h.expires_at)).size, 1, 'Admission does not renew the provisional lease');
      assert.ok(survivors.every(h => h.caller_id === a && h.phase === 'provisional'));
      const rows = await persistedHolds();
      assert.deepEqual(rows.map(row => row.request_id).sort(), survivors.map(h => h.request_id).sort(), 'Only surviving requests have persisted holds');
      assert.equal(rows.filter(row => row.kind === 'catalog').length, 4);
      assert.ok(rows.every(row => row.caller_id === a && row.member_identity === survivors[0].member_identity));
      const leases = await store.leases();
      assert.equal(leases.length, 2);
      const aLease = leases.find(lease => lease.caller_id === a)!;
      assert.equal(aLease.phase, 'provisional');
      assert.equal(aLease.last_success_at, null);
      assert.equal(aLease.active_requests, survivors.length);
      const [events] = await admin.query<RowDataPacket[]>(`SELECT action FROM \`${database}\`.user_pool_events WHERE caller_id=?`, [a]);
      assert.deepEqual(events.map(row => row.action), ['lease_acquired'], 'Canceled requests cannot leave extra lease creation or renewal events');

      await Promise.all(survivors.map(h => store.finish(h, false)));
      assert.deepEqual(await persistedHolds(), []);
      await store.release(aLease.lease_id);
      await second.release(bHeld.lease_id);
      await assertNoBinding(a);
      await assertNoBinding(b);
      const [locks] = await admin.query<RowDataPacket[]>('SELECT IS_USED_LOCK(?) AS owner', [lockName(database, a)]);
      assert.equal(locks[0].owner, null, 'The caller named lock is released after the FIFO drains');
    });

    await t.test('queue wait consumes the original SQL budget; a canceled driver waiter retains its ticket until late disposal; all three pool slots recover', async () => {
      await reset();
      const a = caller(3);
      await lock(a);
      const occupied = await Promise.all(Array.from({ length: 3 }, async () => {
        const connection = await pool.getConnection();
        retained.add(connection);
        return connection;
      }));
      const controller = new AbortController();
      const keeper = start(store, a, 'lease', controller.signal);
      await eventually(async () => connectionRequests === 1, 'The FIFO head never entered the full real connection pool');
      const budgetMs = 1800;
      const limited = new MysqlPoolStore(secondPool, { ...options, requestTimeoutMs: budgetMs });
      const began = performance.now();
      const follower = start(limited, a, 'catalog');
      await delay(800);
      assert.equal(connectionRequests, 1, 'A local follower must not also queue in mysql2');
      assert.equal((await waiters(a)).length, 0, 'All three sockets are retained by the fixture, so no request can execute GET_LOCK');
      controller.abort(new Error('synthetic-pool-queue-cancel'));
      const aborted = await within(keeper, 300, 'Cancellation did not interrupt the driver queue wait');
      assert.equal(aborted.status, 'rejected');
      if (aborted.status === 'rejected') assert.equal(aborted.reason, controller.signal.reason);
      await delay(25);
      assert.equal(connectionRequests, 1, 'Canceled driver acquisition keeps its local ticket until the late socket is disposed');
      retained.delete(occupied[0]);
      occupied[0].release();
      await eventually(async () => (await waiters(a)).length === 1, 'Follower did not reach GET_LOCK after late head disposal', 500);
      assert.equal(connectionRequests, 2);
      await assertBlockerOwns(a);
      const result = await within(follower, budgetMs + 400 - (performance.now() - began), 'Queue time was not charged to the original SQL deadline');
      const elapsed = performance.now() - began;
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.ok(result.reason instanceof MysqlDeadlineError);
      assert.ok(elapsed >= budgetMs - 150 && elapsed < budgetMs + 400,
        `Queue + SQL wait should share ${budgetMs}ms, not restart after ~800ms in the queue (observed ${Math.round(elapsed)}ms)`);
      await eventually(async () => (await waiters(a)).length === 0, 'Timed-out GET_LOCK socket was not destroyed');
      await assertBlockerOwns(a);
      await assertNoBinding(a);
      assert.deepEqual(await persistedHolds(), []);
      await unlock(a);
      for (const connection of occupied.slice(1)) { retained.delete(connection); connection.release(); }

      // Retain all checkouts simultaneously: a leaked driver waiter/socket would
      // prevent this from resolving even if a single SELECT 1 happened to succeed.
      const recovered = await within(Promise.all(Array.from({ length: 3 }, async () => {
        const connection = await pool.getConnection();
        if (closing) { connection.release(); throw new Error('Fixture closed before pool checkout completed'); }
        retained.add(connection);
        await connection.query('SELECT 1');
        return connection;
      })), 1000, 'All three real pool slots must be available after cancellation and SQL timeout');
      assert.equal(new Set(recovered.map(connection => connection.threadId)).size, 3);
      for (const connection of recovered) { retained.delete(connection); connection.release(); }
      const held = fulfilled(await within(start(store, a, 'lease'), 1000, 'Caller gate did not recover after timeout'));
      const catalog = fulfilled(await within(start(second, caller(4), 'catalog'), 1000, 'Unrelated caller failed after pool recovery'));
      assert.notEqual(held.member_identity, catalog.member_identity);
      await Promise.all([store.finish(held, false), second.finish(catalog, false)]);
      await store.release(held.lease_id);
      await assertNoBinding(a);
      await assertNoBinding(caller(4));
      assert.deepEqual(await persistedHolds(), []);
    });
  } finally {
    // First remove external blockers so even a failed assertion cannot strand a
    // pending request. Observe every admission before ending the tested pool.
    closing = true;
    try {
      try { await blocker?.end(); }
      finally {
        for (const connection of retained) connection.release();
        retained.clear();
      }
      await Promise.all(pending);
      if (first) await Promise.all(admitted.map(held => first!.finish(held, false)));
    } finally {
      try { await db?.end(); }
      finally {
        try { if (created) await admin.query(`DROP DATABASE \`${database}\``); }
        finally { await admin.end(); }
      }
    }
  }
});
