import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import { UserPoolError } from './config.js';
import { MysqlDeadline, MysqlDeadlineError } from './mysqlDeadline.js';
import {
  acquireMysqlCaller, mysqlCallerGateStats, MYSQL_CALLER_QUEUE_LIMIT, MYSQL_CALLER_TICKET_LIMIT,
  type MysqlCallerPermit,
} from './mysqlCallerGate.js';

const pool = () => ({ getConnection() { assert.fail('the local gate must not acquire connections'); } } as unknown as Pool);
const deadline = () => new MysqlDeadline();
const empty = (db: Pool) => assert.deepEqual(mysqlCallerGateStats(db), { retainedTickets: 0, scopes: 0, active: 0, queued: 0 });
const overflow = (error: unknown) => error instanceof UserPoolError && error.status === 503
  && error.code === 'pool_storage_unavailable' && error.retryAfter === 1;

test('FIFO per caller, independent callers/pools, and idempotent release with empty map cleanup', async () => {
  const db = pool(), other = pool();
  const first = await acquireMysqlCaller(db, 'A', deadline());
  const order: number[] = [];
  const queued = Array.from({ length: 8 }, (_, i) => acquireMysqlCaller(db, 'A', deadline()).then(permit => {
    order.push(i);
    permit.release();
    permit.release();
  }));
  const independent = await acquireMysqlCaller(db, 'B', deadline());
  const otherPool = await acquireMysqlCaller(other, 'A', deadline());
  assert.deepEqual(order, []);
  assert.deepEqual(mysqlCallerGateStats(db), { retainedTickets: 11, scopes: 2, active: 2, queued: 8 });
  independent.release();
  otherPool.release();
  first.release();
  first.release();
  await Promise.all(queued);
  assert.deepEqual(order, Array.from({ length: 8 }, (_, i) => i));
  empty(db);
  empty(other);
});

test('exactly 32 queued tickets per caller; overflow allocates no new scopes', async () => {
  const db = pool();
  const first = await acquireMysqlCaller(db, 'A', deadline());
  const controllers = Array.from({ length: MYSQL_CALLER_QUEUE_LIMIT }, () => new AbortController());
  const queued = controllers.map(controller => acquireMysqlCaller(db, 'A', deadline(), controller.signal));
  const outcomes = Promise.allSettled(queued);
  try {
    assert.equal(MYSQL_CALLER_QUEUE_LIMIT, 32);
    await assert.rejects(acquireMysqlCaller(db, 'A', deadline()), overflow);
    assert.equal(mysqlCallerGateStats(db).retainedTickets, 33);
    const b = await acquireMysqlCaller(db, 'B', deadline());
    b.release();
  } finally {
    controllers.forEach(controller => controller.abort());
    first.release();
    await outcomes;
  }
  empty(db);
});

test('1024 retained active + queued tickets is a process-wide cap across pool scopes and wrappers', async () => {
  const db = pool(), other = pool();
  const controllers: AbortController[] = [];
  const active: MysqlCallerPermit[] = [];
  const pending: Promise<MysqlCallerPermit>[] = [];
  let outcomes: Promise<PromiseSettledResult<MysqlCallerPermit>[]> | undefined;
  try {
    // 32 pools/callers x (one active + 31 waiters) exercises both ticket kinds.
    for (let scope = 0; scope < 32; scope++) {
      const wrapper = { pool: scope % 2 ? db : other, getConnection: db.getConnection } as unknown as Pool;
      active.push(await acquireMysqlCaller(wrapper, String(scope), deadline()));
      for (let index = 0; index < 31; index++) {
        const controller = new AbortController();
        controllers.push(controller);
        pending.push(acquireMysqlCaller(wrapper, String(scope), deadline(), controller.signal));
      }
    }
    outcomes = Promise.allSettled(pending);
    assert.equal(MYSQL_CALLER_TICKET_LIMIT, 1024);
    assert.equal(mysqlCallerGateStats(db).retainedTickets, 1024);
    await assert.rejects(acquireMysqlCaller(pool(), 'new pool', deadline()), overflow);
    await assert.rejects(acquireMysqlCaller(db, 'new caller', deadline()), overflow);
    assert.equal(mysqlCallerGateStats(db).scopes, 16);
    // Canceling one waiter immediately returns capacity to a different pool/caller.
    controllers[0].abort();
    const recovered = await acquireMysqlCaller(pool(), 'recovered', deadline());
    recovered.release();
  } finally {
    controllers.forEach(controller => controller.abort());
    active.forEach(permit => permit.release());
    await (outcomes ?? Promise.allSettled(pending));
  }
  empty(db);
  empty(other);
});

test('many promise wrappers around one underlying mysql2 pool share the gate', async () => {
  const underlying = pool();
  const wrappers = Array.from({ length: 33 }, () => ({ pool: underlying, getConnection: underlying.getConnection } as unknown as Pool));
  const first = await acquireMysqlCaller(wrappers[0], 'A', deadline());
  const order: number[] = [];
  const pending = wrappers.slice(1).map((wrapper, index) => acquireMysqlCaller(wrapper, 'A', deadline()).then(permit => {
    order.push(index);
    permit.release();
  }));
  assert.deepEqual(mysqlCallerGateStats(underlying), { retainedTickets: 33, scopes: 1, active: 1, queued: 32 });
  first.release();
  await Promise.all(pending);
  assert.deepEqual(order, Array.from({ length: 32 }, (_, i) => i));
  empty(underlying);
});

test('queued cancellation and expiry remove waiters and listeners without disturbing FIFO', async () => {
  const db = pool();
  const first = await acquireMysqlCaller(db, 'A', deadline());
  const controller = new AbortController();
  const reason = new Error('disconnect');
  const canceled = acquireMysqlCaller(db, 'A', deadline(), controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort(reason);
  await assert.rejects(canceled, error => error === reason);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(acquireMysqlCaller(db, 'A', new MysqlDeadline(10)), MysqlDeadlineError);
  assert.equal(mysqlCallerGateStats(db).queued, 0);
  const next = acquireMysqlCaller(db, 'A', deadline());
  first.release();
  (await next).release();
  empty(db);
});

test('grant/abort race releases handed-off permit exactly once and advances the next waiter', async () => {
  const db = pool();
  const first = await acquireMysqlCaller(db, 'A', deadline());
  const controller = new AbortController();
  const raced = acquireMysqlCaller(db, 'A', deadline(), controller.signal);
  const next = acquireMysqlCaller(db, 'A', deadline());
  first.release(); // Resolves the waiter's deferred promise; deadline continuation is not run yet.
  controller.abort();
  await assert.rejects(raced, error => error === controller.signal.reason);
  const granted = await next;
  assert.equal(mysqlCallerGateStats(db).retainedTickets, 1);
  granted.release();
  empty(db);
});

test('expiry racing FIFO handoff disposes the late permit and advances the next waiter', async () => {
  const db = pool();
  const first = await acquireMysqlCaller(db, 'A', deadline());
  const expired = acquireMysqlCaller(db, 'A', new MysqlDeadline(5));
  const rejected = assert.rejects(expired, MysqlDeadlineError);
  const next = acquireMysqlCaller(db, 'A', deadline());
  // Keep the timer callback from running: handoff fulfillment itself must recheck
  // monotonic time and release its late permit, not rely on timer scheduling.
  const until = performance.now() + 10;
  while (performance.now() < until) { /* Deliberately delay timers for this race. */ }
  first.release();
  await rejected;
  (await next).release();
  empty(db);
});

test('an uncancelable acquisition reference keeps the head active until late disposal', async () => {
  const db = pool();
  const first = await acquireMysqlCaller(db, 'A', deadline());
  const disposal = first.retain();
  const next = acquireMysqlCaller(db, 'A', deadline());
  first.release();
  first.release();
  assert.equal(mysqlCallerGateStats(db).queued, 1);
  assert.equal(mysqlCallerGateStats(db).retainedTickets, 2);
  disposal();
  disposal();
  const second = await next;
  second.release();
  assert.throws(() => first.retain(), /released/);
  empty(db);
});

test('already aborted or expired requests never retain a gate ticket', async () => {
  const db = pool();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(acquireMysqlCaller(db, 'A', deadline(), controller.signal), error => error === controller.signal.reason);
  await assert.rejects(acquireMysqlCaller(db, 'A', new MysqlDeadline(0)), MysqlDeadlineError);
  empty(db);
});
