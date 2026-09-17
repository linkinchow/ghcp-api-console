import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise';
import { runMysqlMigrations } from '../db/mysqlMigrations.js';
import { readPoolConfig, UserPoolError } from './config.js';
import { MysqlPoolStore } from './mysqlStore.js';

const env = {
  ACCOUNT_ROUTING_MODE: 'caller-lease', STORAGE_DRIVER: 'mysql',
  POOL_ACCOUNT_EMAIL_DOMAIN: 'synthetic.example.test', POOL_WARMUP_MODEL: 'synthetic-no-http',
  READY_IDLE_TARGET: '4', POOL_MAX_ACCOUNTS: '6',
};
const options = readPoolConfig(env); // Real 120s legacy deadline and 300s provisional lease, not accelerated settings.
const mysqlUrl = process.env.MYSQL_TEST_URL;
const skip = Boolean(mysqlUrl) && process.env.MYSQL_POOL_TEST_DISPOSABLE === '1' ? false
  : 'Requires loopback MYSQL_TEST_URL and MYSQL_POOL_TEST_DISPOSABLE=1; creates a fresh synthetic database.';
const caller = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;
interface Fixture { db: Pool; first: MysqlPoolStore; observer: MysqlPoolStore }

// Match the lifecycle fixture safety contract: URL database is NEVER selected or dropped;
// only a fresh random sibling database is touched, with no provider/network HTTP traffic.
async function withDatabase(run: (f: Fixture) => Promise<void>) {
  assert.equal(process.env.MYSQL_POOL_TEST_DISPOSABLE, '1');
  const url = new URL(mysqlUrl!);
  assert.equal(url.protocol, 'mysql:');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Refusing non-loopback MySQL');
  assert.match(url.pathname, /^\/ghcp_pool_test_[a-z0-9_]+$/);
  assert.equal(url.search + url.hash, '');
  const database = `ghcp_pool_test_${randomUUID().replaceAll('-', '')}`;
  assert.notEqual(url.pathname, `/${database}`);
  url.pathname = '/';
  const admin = createPool({ uri: url.toString(), connectionLimit: 1, connectTimeout: 5000 });
  const pools: Pool[] = [];
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    created = true;
    url.pathname = `/${database}`;
    for (let i = 0; i < 2; i++) pools.push(createPool({ uri: url.toString(), connectionLimit: 4,
      connectTimeout: 5000, timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true }));
    const [db, other] = pools;
    await runMysqlMigrations(db);
    assert.equal(options.requestTimeoutMs, 120000);
    const extendedConfig = readPoolConfig({ ...env, POOL_INFERENCE_TIMEOUT_SECONDS: '600' });
    assert.deepEqual(extendedConfig, options, 'runtime-only setting cannot alter fingerprint inputs');
    const first = new MysqlPoolStore(db, extendedConfig);
    await first.initialize();
    const [before] = await db.query<RowDataPacket[]>('SELECT config_fingerprint FROM user_pool_settings');
    const observer = new MysqlPoolStore(other, options);
    await observer.initialize();
    const [after] = await db.query<RowDataPacket[]>('SELECT config_fingerprint FROM user_pool_settings');
    assert.deepEqual(after, before, 'legacy observer initializes without fingerprint changes');
    await run({ db, first, observer });
  } finally {
    const closed = await Promise.allSettled(pools.map(pool => pool.end()));
    try { if (created) await admin.query(`DROP DATABASE \`${database}\``); }
    finally { await admin.end(); }
    for (const result of closed) if (result.status === 'rejected') throw result.reason;
  }
}

async function ready(f: Fixture) {
  const row = await f.first.reserve();
  assert.ok(row);
  await f.db.execute(`UPDATE proxy_accounts SET copilot_oauth_status='valid', copilot_oauth_token=?, gh_login=? WHERE identity=?`,
    [`SyntheticToken-${row.identity}`, row.identity, row.identity]);
  assert.equal(await f.first.update(row.identity, { state: 'ready', stage: 'ready', verified_at: await f.first.now() }), true);
  return row.identity;
}
async function code(action: Promise<unknown>, expected: string) {
  await assert.rejects(action, error => error instanceof UserPoolError && error.code === expected);
}
// Age only this fixture's persisted timestamps rather than sleeping minutes or changing
// runtime configuration. DB-time production checks remain real; 1s margins avoid boundary races.
async function age(f: Fixture, ms: number) {
  await f.db.execute('UPDATE user_pool_leases SET assigned_at=assigned_at-?, expires_at=expires_at-?', [ms, ms]);
  await f.db.execute('UPDATE user_pool_holds SET deadline_at=deadline_at-?, expires_at=expires_at-?', [ms, ms]);
  await f.db.execute('UPDATE user_pool_catalog_holds SET assigned_at=assigned_at-?, deadline_at=deadline_at-?, expires_at=expires_at-?', [ms, ms, ms]);
}
async function hold(f: Fixture, request: string, table = 'user_pool_holds') {
  const [[row]] = await f.db.query<RowDataPacket[]>(`SELECT deadline_at, expires_at FROM ${table} WHERE request_id=?`, [request]);
  return row;
}
async function snapshot(f: Fixture) {
  return Promise.all(['user_pool_settings', 'user_pool_accounts', 'user_pool_leases', 'user_pool_holds',
    'user_pool_catalog_holds', 'user_pool_events'].map(async table => (await f.db.query(`SELECT * FROM ${table}`))[0]));
}

test('MySQL inference timeout: legacy observer retains 600s hold and renews after 350s; catalog stays 120s',
  { skip, timeout: 60000 }, async () => withDatabase(async f => {
    const member = await ready(f);
    const legacy = await f.first.acquire(caller(1));
    const extended = await f.first.acquire(caller(1), undefined, 600000);
    const catalog = await f.first.acquireCatalog(caller(1));
    assert.equal(extended.lease_id, legacy.lease_id);
    assert.equal(extended.expires_at, legacy.expires_at);
    assert.equal(legacy.expires_at - legacy.assigned_at, 300000);
    for (const [held, expected] of [[legacy, 120000], [extended, 600000], [catalog, 120000]] as const) {
      const row = await hold(f, held.request_id, held.kind === 'catalog' ? 'user_pool_catalog_holds' : 'user_pool_holds');
      assert.equal(Number(row.deadline_at), held.deadline_at);
      assert.equal(Number(row.expires_at) - Number(row.deadline_at), 10000);
      const remaining = Number(row.deadline_at) - await f.first.now();
      assert.ok(remaining > expected - 5000 && remaining <= expected);
    }
    await age(f, 301000);
    const before = await hold(f, extended.request_id);
    assert.equal(await f.observer.heartbeat(extended), true);
    assert.equal(await f.observer.heartbeat(legacy), false);
    assert.equal(await f.observer.heartbeat(catalog), false);
    await f.observer.reclaim();
    assert.equal(await f.observer.hasHolds(member), true);
    assert.deepEqual(await hold(f, extended.request_id), before);
    await code(f.observer.release(extended.lease_id), 'lease_in_use');
    await code(f.observer.acquire(caller(1)), 'lease_draining');
    await code(f.observer.acquire(caller(2)), 'pool_exhausted');
    await age(f, 49000);
    await f.observer.finish(extended, true);
    const active = (await f.observer.leases())[0];
    assert.equal(active.lease_id, extended.lease_id);
    assert.equal(active.phase, 'active');
    assert.ok(active.last_success_at);
    assert.equal(active.expires_at - active.last_success_at, options.leaseSeconds * 1000);
    assert.equal(await hold(f, extended.request_id), undefined);
    await f.first.finish(extended, true);
    assert.deepEqual((await f.first.leases())[0], active);
  }));

test('MySQL inference timeout: invalid overrides/canceled admission never mutate SQL; failed long hold cleans up',
  { skip, timeout: 60000 }, async () => withDatabase(async f => {
    const member = await ready(f);
    const held = await f.first.acquire(caller(1), undefined, 600000);
    await age(f, 350000);
    const before = await snapshot(f);
    for (const value of [0, 4999, 600001, 5000.5, NaN, Infinity, '600000', null] as unknown as number[]) {
      await assert.rejects(f.first.acquire(caller(2), undefined, value));
      assert.deepEqual(await snapshot(f), before);
    }
    const controller = new AbortController();
    const reason = new Error('synthetic disconnect');
    controller.abort(reason);
    await assert.rejects(f.first.acquire(caller(2), controller.signal, 600000), error => error === reason);
    assert.deepEqual(await snapshot(f), before);
    await f.observer.finish(held, false);
    assert.equal(await hold(f, held.request_id), undefined);
    assert.equal((await f.observer.leases()).length, 0);
    assert.equal((await f.observer.acquire(caller(2))).member_identity, member);
  }));

test('MySQL inference timeout: 600s expiry drains before reassignment and generation fences long holds',
  { skip, timeout: 60000 }, async () => withDatabase(async f => {
    const member = await ready(f);
    const held = await f.first.acquire(caller(1), undefined, 600000);
    await age(f, 601000);
    assert.equal(await f.observer.heartbeat(held), false);
    await f.observer.reclaim();
    assert.equal(await f.observer.hasHolds(member), true);
    await code(f.observer.release(held.lease_id), 'lease_in_use');
    await age(f, 10000);
    await f.observer.reclaim();
    assert.equal(await f.observer.hasHolds(member), false);
    const replacement = await f.observer.acquire(caller(2), undefined, 600000);
    await f.first.finish(held, true);
    assert.equal((await f.first.leases())[0].lease_id, replacement.lease_id);
    await age(f, 350000);
    await f.db.execute('UPDATE user_pool_accounts SET generation=generation+1 WHERE identity=?', [member]);
    assert.equal(await f.first.heartbeat(replacement), false);
    assert.equal(await f.first.cool(member, 60, replacement), false);
    assert.equal(await f.first.quarantine(member, 'synthetic_stale', replacement), false);
    await f.first.finish(replacement, true);
    assert.equal(await hold(f, replacement.request_id), undefined);
    assert.equal((await f.first.leases()).length, 0);
  }));
