import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createPool } from 'mysql2/promise';
import { runMigrations } from '../db/migrations.js';
import { runMysqlMigrations } from '../db/mysqlMigrations.js';
import { UserPoolStore } from './store.js';
import { MysqlPoolStore } from './mysqlStore.js';
import { readPoolConfig } from './config.js';
import type { PoolStore } from './storage.js';

const options = readPoolConfig({ ACCOUNT_ROUTING_MODE: 'caller-lease', STORAGE_DRIVER: 'mysql',
  POOL_ACCOUNT_EMAIL_DOMAIN: 'scheduler.test', POOL_WARMUP_MODEL: 'synthetic', READY_IDLE_TARGET: '0',
  POOL_MAX_ACCOUNTS: '3000', POOL_LOGIN_MAX_PENDING: '5' });
type Query = (sql: string, values?: unknown[]) => Promise<unknown>;

async function contract(store: PoolStore, query: Query) {
  const now = await store.now();
  for (let start = 0; start < 2011; start += 100) {
    const accounts: unknown[][] = [], members: unknown[][] = [];
    for (let i = start; i < Math.min(start + 100, 2011); i++) {
      const identity = `synthetic-scheduler-${String(i).padStart(4, '0')}`;
      accounts.push([identity, identity, 'synthetic-token', 'valid', '2026-01-01 00:00:00', '2026-01-01 00:00:00']);
      const stage = i < 2000 ? 'oauth-starting' : i < 2005 ? 'oauth-wait' : i < 2010 ? 'warmup' : 'new';
      members.push([identity, i, 'provisioning', stage, randomUUID(), i === 2010 ? 0 : i < 2000 ? 1 : 2, now]);
    }
    await query(`INSERT INTO proxy_accounts(identity,sso_user,copilot_oauth_token,copilot_oauth_status,created_at,updated_at)
      VALUES ${accounts.map(() => '(?,?,?,?,?,?)').join(',')}`, accounts.flat());
    await query(`INSERT INTO user_pool_accounts(identity,ordinal,state,stage,attempt_id,retry_at,updated_at)
      VALUES ${members.map(() => '(?,?,?,?,?,?,?)').join(',')}`, members.flat());
  }
  const excluded: string[] = [], stages: string[] = [];
  for (let i = 0; i < 14; i++) {
    const row = await store.pending(excluded);
    if (!row) break;
    assert.notEqual(row.stage, 'oauth-starting', 'Full Login capacity must skip 2000 blocked starters before external work');
    excluded.push(row.identity); stages.push(row.stage);
  }
  assert.equal(stages.filter(stage => stage === 'warmup').length, 5);
  assert.equal(stages.filter(stage => stage === 'oauth-wait').length, 5);
  assert.ok(stages.indexOf('new') >= 0 && stages.indexOf('new') < 4, 'Age selection prevents indefinite upstream starvation');
  assert.equal(stages.length, 11);
  assert.equal(await store.pending(excluded), undefined);

  // Failed/disabled uncertain reservations still occupy capacity even when not eligible to run.
  await query("UPDATE user_pool_accounts SET state='disabled' WHERE stage='oauth-wait'");
  assert.equal(await store.pending(excluded), undefined);
  await query("UPDATE user_pool_accounts SET state='failed',attempts=3 WHERE stage='oauth-wait'");
  assert.equal(await store.pending(excluded), undefined);
  await query("UPDATE user_pool_accounts SET stage='warmup' WHERE ordinal=2000");
  const selected = (await store.pending(excluded))!;
  assert.equal(selected.stage, 'oauth-starting', 'A freed slot makes a starter eligible without rewriting its retry time');

  // Selection is advisory: another dispatch may take the slot before this row's final claim.
  await query("UPDATE user_pool_accounts SET stage='oauth-dispatch' WHERE ordinal=2000");
  const owner = randomUUID(); assert.equal(await store.claimOwner(owner), true);
  const fence = { attempt_id: selected.attempt_id, generation: selected.generation, stage: selected.stage };
  assert.equal(await store.claimLoginDispatch(selected.identity, fence, owner, 5), false);
  assert.equal((await store.inventory(selected.identity))!.stage, 'oauth-starting');
  await store.releaseOwner(owner);

  // Future retry times and pause are still authoritative, even for high-priority work.
  await query("UPDATE user_pool_accounts SET retry_at=? WHERE stage IN ('warmup','new')", [now + 3600000]);
  assert.equal(await store.pending(), undefined);
  const settings = await store.settings(); await store.updateSettings(settings.version, { paused: 1 });
  await query('UPDATE user_pool_accounts SET retry_at=0');
  assert.equal(await store.pending(), undefined);
}

test('SQLite capacity-aware fair scheduling advances downstream work past 2000 starters', async () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); runMigrations(db);
  try {
    const store = new UserPoolStore(db, options);
    await contract(store, async (sql, values = []) => db.prepare(sql).run(...values));
  } finally { db.close(); }
});

test('MySQL capacity-aware fair scheduling preserves holds and final claim under backlog', {
  skip: !process.env.MYSQL_TEST_URL || process.env.MYSQL_POOL_TEST_DISPOSABLE !== '1', timeout: 120000,
}, async () => {
  const url = new URL(process.env.MYSQL_TEST_URL!);
  assert.equal(url.protocol, 'mysql:'); assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.match(url.pathname, /^\/ghcp_pool_test_[a-z0-9_]+$/); assert.equal(url.search + url.hash, '');
  url.pathname = '/'; const admin = createPool({ uri: url.toString(), connectionLimit: 1 });
  const name = `ghcp_pool_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  url.pathname = '/' + name;
  const db = createPool({ uri: url.toString(), connectionLimit: 3, dateStrings: true, timezone: 'Z' });
  try {
    await runMysqlMigrations(db); const store = new MysqlPoolStore(db, options); await store.initialize();
    await contract(store, async (sql, values = []) => db.query(sql, values));
  } finally { await db.end(); await admin.query(`DROP DATABASE \`${name}\``); await admin.end(); }
});
