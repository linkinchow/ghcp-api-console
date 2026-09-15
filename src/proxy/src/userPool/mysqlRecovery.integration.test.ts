import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPool, type RowDataPacket } from 'mysql2/promise';
import { runMysqlMigrations } from '../db/mysqlMigrations.js';
import { MysqlPoolStore } from './mysqlStore.js';
import { normalizePoolConfig, readPoolConfig } from './config.js';
import { PrewarmWorker } from './worker.js';
import { ProvisionFailure } from './provisioner.js';

const options = readPoolConfig({ ACCOUNT_ROUTING_MODE: 'caller-lease', STORAGE_DRIVER: 'mysql',
  POOL_ACCOUNT_EMAIL_DOMAIN: 'synthetic.test', POOL_WARMUP_MODEL: 'unused-mock', READY_IDLE_TARGET: '1', POOL_MAX_ACCOUNTS: '2000' });
const enabled = Boolean(process.env.MYSQL_TEST_URL) && process.env.MYSQL_POOL_TEST_DISPOSABLE === '1';

test('MySQL production regressions: bounded backlog, defaults and terminal callback', { skip: !enabled, timeout: 600000 }, async t => {
  const url = new URL(process.env.MYSQL_TEST_URL!);
  assert.equal(url.protocol, 'mysql:');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.match(url.pathname, /^\/ghcp_pool_test_[a-z0-9_]+$/);
  assert.equal(url.search + url.hash, '');
  url.pathname = '/';
  const admin = createPool({ uri: url.toString(), connectionLimit: 1 });
  const database = `ghcp_pool_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  url.pathname = '/' + database;
  const db = createPool({ uri: url.toString(), connectionLimit: 4, dateStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true });
  try {
    await runMysqlMigrations(db);
    const { loginMaxPending: _login, prewarmConcurrency: _prewarm, ...omitted } = options;
    const store = new MysqlPoolStore(db, omitted);
    await store.initialize();
    await t.test('omitted optional defaults match the production parser', async () => {
      assert.deepEqual(normalizePoolConfig(omitted), options);
      await new MysqlPoolStore(db, options).initialize();
      assert.throws(() => new MysqlPoolStore(db, { ...options, loginMaxPending: 0 }), /concurrency/);
    });
    await t.test('database epoch is independent of session time zone', async () => {
      const c = await db.getConnection();
      try {
        await c.query("SET time_zone='+09:00'");
        const [[row]] = await c.query<RowDataPacket[]>("SELECT TIMESTAMPDIFF(MICROSECOND,'1970-01-01',UTC_TIMESTAMP(3)) DIV 1000 AS now");
        assert.ok(Math.abs(await store.now() - Number(row.now)) < 5000);
      } finally { await c.query("SET time_zone='+00:00'"); c.release(); }
    });
    await t.test('credential callback after atomic terminal fail cannot hide the reservation', async () => {
      const member = (await store.reserve())!;
      await store.update(member.identity, { stage: 'oauth-wait', task_id: 'synthetic-task', oauth_attempt_id: 'synthetic-nonce' });
      const fail = store.fail.bind(store);
      store.fail = async (...args) => {
        await fail(...args);
        await db.execute("UPDATE proxy_accounts SET copilot_oauth_token='synthetic-callback',copilot_oauth_status='valid' WHERE identity=?", [member.identity]);
      };
      const worker = new PrewarmWorker(store, { async step() { throw new ProvisionFailure('oauth_task_cancelled_unconfirmed', true); } }, 60000, 1, undefined, { multiReplica: true });
      try {
        await worker.tick();
        const row = (await store.inventory(member.identity))!;
        assert.equal(row.state, 'failed'); assert.equal(row.attempts, 3);
        assert.ok((await store.listLoginReservations()).some(item => item.identity === member.identity));
      } finally { await worker.stop(); store.fail = fail; }
      await db.execute('DELETE FROM user_pool_accounts WHERE identity=?', [member.identity]);
      await db.execute('DELETE FROM proxy_accounts WHERE identity=?', [member.identity]);
    });
    await t.test('2000 expired leases drain in bounded batches despite pinned and locked prefixes', async () => {
      for (let start = 0; start < 2000; start += 100) {
        const accounts: unknown[][] = [], members: unknown[][] = [], leases: unknown[][] = [];
        for (let n = start; n < start + 100; n++) {
          const identity = `synthetic-expiry-${String(n).padStart(4, '0')}`;
          accounts.push([identity, identity, 'synthetic-token', 'valid']);
          members.push([identity, n, 'ready', 'ready', randomUUID(), 1, 1]);
          leases.push([`sha256:${n.toString(16).padStart(64, '0')}`, identity, randomUUID(), 'active', 1, 1, 1]);
        }
        await db.query(`INSERT INTO proxy_accounts(identity,sso_user,copilot_oauth_token,copilot_oauth_status,created_at,updated_at) VALUES ${accounts.map(() => '(?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))').join(',')}`, accounts.flat());
        await db.query(`INSERT INTO user_pool_accounts(identity,ordinal,state,stage,attempt_id,updated_at,verified_at) VALUES ${members.map(() => '(?,?,?,?,?,?,?)').join(',')}`, members.flat());
        await db.query(`INSERT INTO user_pool_leases(caller_id,member_identity,lease_id,phase,assigned_at,last_success_at,expires_at) VALUES ${leases.map(() => '(?,?,?,?,?,?,?)').join(',')}`, leases.flat());
      }
      const now = await store.now();
      await db.execute(`INSERT INTO user_pool_holds(request_id,lease_id,expires_at,deadline_at,generation)
        SELECT UUID(),lease_id,?,?,0 FROM user_pool_leases WHERE member_identity<'synthetic-expiry-0032'`, [now + 900000, now + 890000]);
      const blocker = await db.getConnection();
      await blocker.beginTransaction();
      await blocker.execute("SELECT identity FROM proxy_accounts WHERE identity='synthetic-expiry-0032' FOR UPDATE");
      const remaining = async () => Number((await db.query<RowDataPacket[]>('SELECT COUNT(*) total FROM user_pool_leases'))[0][0].total);
      try {
        await store.reclaim();
        assert.equal(await remaining(), 2000, 'First batch remains pinned');
        for (let pass = 0; pass < 40 && await remaining() === 2000; pass++) await store.reclaim();
        assert.ok(await remaining() < 2000, 'Cursor advances beyond held/locked prefix');
      } finally { await blocker.rollback(); blocker.release(); }
      for (let pass = 0; pass < 300 && await remaining() > 32; pass++) await store.reclaim();
      assert.equal(await remaining(), 32);
      await db.execute('UPDATE user_pool_leases SET expires_at=1');
      await db.query('DELETE FROM user_pool_holds');
      await db.execute('UPDATE user_pool_settings SET max_accounts=2100,idle_target=100 WHERE id=1');
      assert.equal(await store.reserve(), undefined, 'Expired reusable inventory prevents unnecessary provisioning before all batches drain');
      for (let pass = 0; pass < 10 && await remaining(); pass++) await store.reclaim();
      assert.equal(await remaining(), 0);
      assert.equal((await store.counts()).ready_idle, 2000);
      await db.query("UPDATE proxy_accounts SET copilot_oauth_token='synthetic-refreshed-token'");
      assert.equal(await store.reserve(), undefined, 'Unprocessed credential verification backlog counts toward future capacity');
      assert.equal(Number((await db.query<RowDataPacket[]>('SELECT COUNT(*) total FROM user_pool_accounts'))[0][0].total), 2000);
    });
  } finally {
    await db.end(); await admin.query(`DROP DATABASE \`${database}\``); await admin.end();
  }
});
