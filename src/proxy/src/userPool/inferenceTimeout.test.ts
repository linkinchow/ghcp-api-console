import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import { readPoolConfig, UserPoolError } from './config.js';
import { inferenceHoldTimeoutMs, readInferenceTimeoutMs } from './inferenceTimeout.js';
import { UserPoolStore } from './store.js';

const env = {
  ACCOUNT_ROUTING_MODE: 'caller-lease', POOL_ACCOUNT_EMAIL_DOMAIN: 'accounts.example.test',
  POOL_WARMUP_MODEL: 'synthetic-no-http', READY_IDLE_TARGET: '4', POOL_MAX_ACCOUNTS: '6',
};
const options = readPoolConfig(env);
const caller = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;
const invalidOverrides = [0, -1, 4999, 600001, 5000.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1,
  '600000', null, true] as unknown as number[];

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'pool-inference-timeout-'));
  const path = join(dir, 'pool.sqlite');
  const clock = { now: 1_800_000_000_000 };
  const connections: BetterSqlite3.Database[] = [];
  function connect() {
    const db = new BetterSqlite3(path);
    connections.push(db);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    runMigrations(db);
    const store = new UserPoolStore(db, { ...options });
    store.now = () => clock.now;
    return { db, store };
  }
  const first = connect();
  t.after(() => {
    for (const db of connections) if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  function ready() {
    const row = first.store.reserve();
    assert.ok(row);
    first.db.prepare(`UPDATE proxy_accounts SET copilot_oauth_token=?, copilot_oauth_status='valid', gh_login=? WHERE identity=?`)
      .run(`SyntheticToken-${row.identity}`, row.identity, row.identity);
    first.store.update(row.identity, { state: 'ready', stage: 'ready', verified_at: clock.now });
    return row.identity;
  }
  return { ...first, clock, connect, ready };
}

function code(action: () => unknown, expected: string) {
  assert.throws(action, error => error instanceof UserPoolError && error.code === expected);
}

function hold(db: BetterSqlite3.Database, request: string, table = 'user_pool_holds') {
  return db.prepare(`SELECT deadline_at, expires_at, generation FROM ${table} WHERE request_id=?`)
    .get(request) as { deadline_at: number; expires_at: number; generation: number } | undefined;
}

function snapshot(db: BetterSqlite3.Database) {
  return ['user_pool_settings', 'user_pool_accounts', 'user_pool_leases', 'user_pool_holds',
    'user_pool_catalog_holds', 'user_pool_events'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

test('inference timeout parser: unset/direct mode, integer seconds boundaries and independent legacy configuration', () => {
  assert.equal(readInferenceTimeoutMs({}, true), undefined);
  assert.equal(readInferenceTimeoutMs({}, false), undefined);
  for (const raw of ['5', '120', '300', '600']) {
    assert.equal(readInferenceTimeoutMs({ POOL_INFERENCE_TIMEOUT_SECONDS: raw }, true), Number(raw) * 1000);
    assert.equal(readInferenceTimeoutMs({ POOL_INFERENCE_TIMEOUT_SECONDS: raw }, false), undefined);
  }
  assert.equal(readInferenceTimeoutMs({ POOL_REQUEST_TIMEOUT_SECONDS: '600' }, true), undefined);
  assert.equal(readInferenceTimeoutMs({ POOL_REQUEST_TIMEOUT_SECONDS: '5', POOL_INFERENCE_TIMEOUT_SECONDS: '600' }, true), 600000);
  assert.equal(options.requestTimeoutMs, 120000);
  assert.deepEqual(readPoolConfig({ ...env, POOL_INFERENCE_TIMEOUT_SECONDS: '600' }), options,
    'runtime-only override must not enter PoolConfig or its persisted fingerprint');
  assert.equal(readPoolConfig({ ...env, POOL_REQUEST_TIMEOUT_SECONDS: '5' }).requestTimeoutMs, 5000);
});

test('inference timeout parser rejects malformed raw values only when enabled', () => {
  for (const raw of ['', ' ', '4', '601', '0', '-5', '+5', '5.0', '5.5', '6e2', '0x10',
    ' 600', '600 ', '600\n', '\t600', 'NaN', 'Infinity', '9007199254740992', '６００']) {
    assert.throws(() => readInferenceTimeoutMs({ POOL_INFERENCE_TIMEOUT_SECONDS: raw }, true), JSON.stringify(raw));
    assert.equal(readInferenceTimeoutMs({ POOL_INFERENCE_TIMEOUT_SECONDS: raw }, false), undefined);
  }
});

test('inference hold resolver validates only explicit millisecond overrides and leaves fallback untouched', () => {
  for (const value of [5000, 5001, 120000, 600000]) assert.equal(inferenceHoldTimeoutMs(value, 120000), value);
  for (const value of invalidOverrides) assert.throws(() => inferenceHoldTimeoutMs(value, 120000), String(value));
  for (const fallback of [0, 1, 4999, 120000, 600001, 1.5, NaN, Infinity]) {
    assert.ok(Object.is(inferenceHoldTimeoutMs(undefined, fallback), fallback));
  }
});

test('SQLite inference holds independently persist 120s versus 600s plus 10s drain; catalog remains 120s', t => {
  const f = fixture(t);
  f.ready();
  const start = f.clock.now;
  const legacy = f.store.acquire(caller(1));
  const extended = f.store.acquire(caller(1), undefined, 600000);
  const catalog = f.store.acquireCatalog(caller(1));
  assert.equal(legacy.lease_id, extended.lease_id);
  assert.equal(legacy.expires_at, start + 300000);
  assert.equal(extended.expires_at, legacy.expires_at, 'override must not extend provisional lease');
  assert.equal(legacy.deadline_at, start + 120000);
  assert.equal(extended.deadline_at, start + 600000);
  assert.equal(catalog.deadline_at, start + 120000);
  for (const [held, seconds] of [[legacy, 120], [extended, 600], [catalog, 120]] as const) {
    const row = hold(f.db, held.request_id, held.kind === 'catalog' ? 'user_pool_catalog_holds' : 'user_pool_holds')!;
    assert.equal(row.deadline_at, start + seconds * 1000);
    assert.equal(row.expires_at, row.deadline_at + 10000);
  }
  f.clock.now = start + 120000;
  const observer = f.connect().store;
  assert.equal(observer.heartbeat(legacy), false);
  assert.equal(observer.heartbeat(catalog), false);
  assert.equal(observer.heartbeat(extended), true);
});

test('SQLite legacy observer honors 600s persisted hold through provisional expiry and success at 350s', t => {
  const f = fixture(t);
  const member = f.ready();
  const start = f.clock.now;
  const held = f.store.acquire(caller(1), undefined, 600000);
  const originalHold = hold(f.db, held.request_id);
  const observer = f.connect().store; // Same legacy 120s PoolConfig, no runtime override.
  for (const elapsed of [120000, 130000, 299999, 300000, 300001]) {
    f.clock.now = start + elapsed;
    assert.equal(observer.heartbeat(held), true);
    observer.reclaim();
    assert.equal(observer.hasHolds(member), true);
    assert.deepEqual(hold(f.db, held.request_id), originalHold, 'heartbeat/reclaim cannot shorten or extend persisted deadline');
    code(() => observer.release(held.lease_id), 'lease_in_use');
  }
  code(() => observer.acquire(caller(1)), 'lease_draining');
  code(() => observer.acquire(caller(2)), 'pool_exhausted');
  f.clock.now = start + 350000;
  observer.finish(held, true);
  const active = observer.leases()[0];
  assert.equal(active.lease_id, held.lease_id);
  assert.equal(active.member_identity, member);
  assert.equal(active.phase, 'active');
  assert.equal(active.last_success_at, f.clock.now);
  assert.equal(active.expires_at, f.clock.now + options.leaseSeconds * 1000);
  assert.equal(hold(f.db, held.request_id), undefined);
  f.clock.now += 1000;
  observer.finish(held, true);
  assert.deepEqual(observer.leases()[0], active, 'duplicate finish cannot renew again');
});

test('SQLite canceled admission and failed long inference remove only their own holds without renewal', t => {
  const f = fixture(t);
  f.ready();
  const controller = new AbortController();
  const reason = new Error('synthetic disconnect');
  controller.abort(reason);
  const before = snapshot(f.db);
  assert.throws(() => f.store.acquire(caller(1), controller.signal, 600000), error => error === reason);
  assert.deepEqual(snapshot(f.db), before);
  const first = f.store.acquire(caller(1), undefined, 600000);
  const second = f.store.acquire(caller(1), undefined, 600000);
  f.clock.now += 350000;
  f.store.finish(first, false); // Runtime cancellation/failure uses unsuccessful completion.
  assert.equal(hold(f.db, first.request_id), undefined);
  assert.ok(hold(f.db, second.request_id));
  assert.equal(f.store.leases()[0].phase, 'provisional');
  assert.equal(f.store.leases()[0].last_success_at, null);
  f.store.finish(second, false);
  assert.equal(f.store.leases().length, 0);
  assert.equal(f.store.hasHolds(first.member_identity), false);
  assert.equal(f.store.acquire(caller(2)).member_identity, first.member_identity);
});

test('SQLite 600s absolute expiry rejects heartbeat, retains exactly 10s drain, and fences stale completion', t => {
  const f = fixture(t);
  const member = f.ready();
  const start = f.clock.now;
  const held = f.store.acquire(caller(1), undefined, 600000);
  const observer = f.connect().store;
  f.clock.now = start + 599999;
  assert.equal(observer.heartbeat(held), true);
  for (const elapsed of [600000, 609999]) {
    f.clock.now = start + elapsed;
    assert.equal(observer.heartbeat(held), false);
    observer.reclaim();
    assert.equal(observer.hasHolds(member), true);
    code(() => observer.release(held.lease_id), 'lease_in_use');
    code(() => observer.acquire(caller(2)), 'pool_exhausted');
  }
  f.clock.now = start + 610000;
  observer.reclaim();
  assert.equal(observer.hasHolds(member), false);
  assert.equal(observer.leases().length, 0);
  const replacement = observer.acquire(caller(2));
  observer.finish(held, true);
  assert.equal(observer.leases()[0].lease_id, replacement.lease_id);
  assert.equal(observer.leases()[0].phase, 'provisional');
});

test('SQLite generation fence defeats a still-unexpired 600s hold', t => {
  const f = fixture(t);
  const member = f.ready();
  const held = f.store.acquire(caller(1), undefined, 600000);
  f.clock.now += 350000;
  f.db.prepare('UPDATE user_pool_accounts SET generation=generation+1 WHERE identity=?').run(member);
  assert.equal(f.store.heartbeat(held), false);
  assert.equal(f.store.cool(member, 60, held), false);
  assert.equal(f.store.quarantine(member, 'synthetic_stale', held), false);
  f.store.finish(held, true);
  assert.equal(hold(f.db, held.request_id), undefined);
  assert.equal(f.store.leases().length, 0, 'stale generation cannot promote an expired provisional lease');
});

test('SQLite invalid inference override fails before admission or even reclamation mutates SQL', t => {
  const f = fixture(t);
  f.ready();
  f.store.acquire(caller(1));
  f.clock.now += 400000; // An admission/reclaim would delete this stale lease and hold.
  const before = snapshot(f.db);
  for (const value of invalidOverrides) {
    assert.throws(() => f.store.acquire(caller(2), undefined, value), String(value));
    assert.deepEqual(snapshot(f.db), before, 'invalid override must be rejected before DB mutation');
  }
});
