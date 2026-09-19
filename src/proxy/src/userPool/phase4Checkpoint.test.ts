import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { createSqlitePoolFixture, fixtureRegistry, TEST_ENTERPRISE } from '../test/enterpriseFixtures.js';
import { MysqlPoolStore } from './mysqlStore.js';
import { realProvisioner, ProvisionFailure, type ProvisionContext, type ProvisionInventory } from './provisioner.js';
import { PrewarmWorker } from './worker.js';
import { type PoolConfig } from './config.js';

const NOW = 1800000000000;
const options: PoolConfig = { enabled: true, accountDomain: 'pool.example.test', idleTarget: 1, maxAccounts: 3,
  leaseSeconds: 600, provisionalSeconds: 30, pollMs: 1000, retryAfterSeconds: 1, warmupModel: 'synthetic', requestTimeoutMs: 1000 };
const transitions = [
  ['new', 'sso-creating', 'sso-created'],
  ['sso-created', 'scim-syncing', 'scim-synced'],
  ['scim-synced', 'seat-assigning', 'synced'],
] as const;

/** Executes production SQL against isolated SQLite after explicit MySQL dialect
 * rewrites. Trace assertions are SQL-contract evidence, NOT real MySQL locking. */
function fixture() {
  const db = new Database(':memory:');
  const sqlite = createSqlitePoolFixture(db, options);
  sqlite.now = () => NOW;
  const row = sqlite.reserve()!;
  const trace: string[] = [];
  const hooks: { beforePolicy?: () => void } = {};
  const pool = { async getConnection() {
    const query = async (raw: string, values: unknown[] = []) => {
      trace.push(raw);
      if (/enterprise_pool_policy.*FOR SHARE/.test(raw)) hooks.beforePolicy?.();
      if (raw.startsWith('SELECT TIMESTAMPDIFF')) return [[{ now: NOW }]];
      if (raw.startsWith('SET TRANSACTION')) return [{ affectedRows: 0 }];
      let sql = raw.replace(/\(TIMESTAMPDIFF\(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP\(3\)\) DIV 1000\)/g, String(NOW))
        .replace(/ FOR (UPDATE|SHARE)( SKIP LOCKED)?/g, '').replaceAll('LEAST(', 'MIN(');
      if (/^DELETE h FROM user_pool_holds/.test(sql)) sql = 'DELETE FROM user_pool_holds WHERE lease_id IN (SELECT lease_id FROM user_pool_leases WHERE member_identity=?) AND expires_at<=?';
      if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/.test(sql)) { db.exec(sql); return [{ affectedRows: 0 }]; }
      if (/^\s*SELECT/.test(sql)) return [db.prepare(sql).all(...values)];
      return [{ affectedRows: db.prepare(sql).run(...values).changes }];
    };
    return { query, execute: query, beginTransaction: () => query('BEGIN'), commit: () => query('COMMIT'),
      rollback: () => query('ROLLBACK'), destroy() {}, release() {} } as unknown as PoolConnection;
  } } as unknown as Pool;
  const mysql = new MysqlPoolStore(pool, options, fixtureRegistry(options));
  const reset = (stage: string, state = 'active') => {
    db.prepare('DELETE FROM user_pool_leases').run();
    db.prepare('UPDATE enterprise_pool_policy SET state=?').run(state);
    db.prepare("UPDATE user_pool_accounts SET stage=?,state='provisioning',attempts=0,last_error=NULL,retry_at=0,verified_at=NULL").run(stage);
    trace.length = 0;
    hooks.beforePolicy = undefined;
    return sqlite.inventory(row.identity)!;
  };
  return { db, sqlite, mysql, row, trace, hooks, reset, close: () => db.close() };
}

for (const backend of ['sqlite', 'mysql'] as const) {
  for (const [source, target, completion] of transitions) {
    test(`checkpoint ${backend}: ${source}->${target} rejects post-drain intent and permits pre-drain completion`, async () => {
      const f = fixture();
      try {
        const store = f[backend];
        let row = f.reset(source, 'draining');
        assert.equal(await store.canProvision(row.identity, 'advance'), false);
        const before = await store.inventory(row.identity);
        assert.equal(await store.update(row.identity, { stage: target }, row), false);
        assert.deepEqual(await store.inventory(row.identity), before, 'denied checkpoint changes no stage, retry budget or generation');
        if (backend === 'mysql') {
          assert.equal(f.trace.some(sql => /proxy_accounts.*FOR UPDATE/s.test(sql)), false, 'rejection precedes account lock');
          assert.equal(f.trace.some(sql => /UPDATE user_pool_accounts/.test(sql)), false);
        }
        row = f.reset(source);
        assert.equal(await store.update(row.identity, { stage: target }, row), true);
        if (backend === 'mysql') {
          const settings = f.trace.findIndex(sql => /user_pool_settings.*FOR UPDATE/.test(sql));
          const policy = f.trace.findIndex(sql => /enterprise_pool_policy.*FOR SHARE/.test(sql));
          const account = f.trace.findIndex(sql => /proxy_accounts.*FOR UPDATE/s.test(sql));
          const write = f.trace.findIndex(sql => /UPDATE user_pool_accounts/.test(sql));
          assert.ok(settings >= 0 && settings < policy && policy < account && account < write);
          assert.ok(!f.trace[policy].includes('JOIN'), 'policy locking query never joins profile');
        }
        f.db.prepare("UPDATE enterprise_pool_policy SET state='draining'").run();
        assert.equal(await store.canProvision(row.identity, 'observe'), true, 'persisted intent remains observable');
        const admitted = (await store.inventory(row.identity))!;
        f.trace.length = 0;
        assert.equal(await store.update(row.identity, { stage: completion }, admitted), true);
        assert.equal(f.trace.some(sql => /FOR SHARE/.test(sql)), false, 'completion cannot acquire a new policy admission lock');
        assert.equal((await store.inventory(row.identity))?.attempts, 0);
      } finally { f.close(); }
    });
  }
  test(`checkpoint ${backend}: live-lease repair permission preserved, expired lease not extended`, async () => {
    const f = fixture();
    try {
      const store = f[backend], row = f.reset('sso-created', 'draining');
      f.db.prepare('INSERT INTO user_pool_leases VALUES(?,?,?,?,?,?,?)').run(`sha256:${'a'.repeat(64)}`, row.identity,
        randomUUID(), 'active', NOW - 1000, NOW - 1000, NOW + 600000);
      assert.equal(await store.update(row.identity, { stage: 'scim-syncing' }, row), true);
      assert.equal((f.db.prepare('SELECT expires_at FROM user_pool_leases').get() as { expires_at: number }).expires_at, NOW + 600000);
      f.db.prepare("UPDATE user_pool_accounts SET stage='scim-synced'").run();
      f.db.prepare('UPDATE user_pool_leases SET expires_at=?').run(NOW - 1);
      assert.equal(await store.update(row.identity, { stage: 'seat-assigning' }, (await store.inventory(row.identity))!), false);
      assert.equal((f.db.prepare('SELECT expires_at FROM user_pool_leases').get() as { expires_at: number }).expires_at, NOW - 1);
    } finally { f.close(); }
  });
  test(`checkpoint ${backend}: worker does not charge a failure when drain wins before intent checkpoint`, async () => {
    const f = fixture();
    let worker: PrewarmWorker | undefined;
    try {
      f.reset('new');
      worker = new PrewarmWorker(f[backend], { async step(row, context) {
        const policy = (await f[backend].enterprisePolicy(TEST_ENTERPRISE.id))!;
        await f[backend].updateEnterprisePolicy(TEST_ENTERPRISE.id, policy.policyVersion, { type: 'drain' });
        await context.checkpoint({ stage: 'sso-creating' });
        assert.fail('denied dispatch checkpoint must stop the worker before provider I/O');
      } }, 60000, 1);
      await worker.tick();
      const after = (await f[backend].inventory(f.row.identity))!;
      assert.equal(after.stage, 'new'); assert.equal(after.attempts, 0); assert.equal(after.last_error, null);
      const events = f.db.prepare("SELECT 1 FROM user_pool_events WHERE action='provision_failed'").all();
      assert.equal(events.length, 0);
    } finally { await worker?.stop(); f.close(); }
  });
}

test('checkpoint SQL contract: drain winning between candidate read and policy SHARE cannot dispatch', async () => {
  const f = fixture();
  try {
    const row = f.reset('new');
    f.hooks.beforePolicy = () => { f.db.prepare("UPDATE enterprise_pool_policy SET state='draining'").run(); };
    assert.equal(await f.mysql.update(row.identity, { stage: 'sso-creating' }, row), false);
    assert.equal(f.trace.some(sql => /proxy_accounts.*FOR UPDATE/s.test(sql)), false);
    assert.equal((await f.mysql.inventory(row.identity))?.stage, 'new');
  } finally { f.close(); }
});

test('checkpoint real provisioner: drain during checkpoint causes zero SSO POSTs', async () => {
  const f = fixture();
  try {
    let row: ProvisionInventory = f.reset('new');
    let posts = 0;
    const context: ProvisionContext = { signal: new AbortController().signal, assertCurrent() {}, pinCredentials() {},
      assertCanAdvance() { if (!f.sqlite.canProvision(row.identity)) throw new ProvisionFailure('enterprise_not_active'); },
      checkpoint(patch) {
        const policy = f.sqlite.enterprisePolicy(TEST_ENTERPRISE.id)!;
        f.sqlite.updateEnterprisePolicy(TEST_ENTERPRISE.id, policy.policyVersion, { type: 'drain' });
        if (!f.sqlite.update(row.identity, patch, row)) throw new ProvisionFailure('provision_fenced');
        row = f.sqlite.inventory(row.identity)!; return row;
      } };
    const adapter = realProvisioner({ now: () => NOW }, options, {
      enterpriseProfile: id => fixtureRegistry(options).profiles.find(profile => profile.id === id)!,
      verifyReadiness: async () => {}, fetch: async (_input, init) => {
        if (init?.method === 'POST') { posts++; assert.fail('new SSO create after drain'); }
        return new Response('{}', { status: 404 });
      },
    });
    await assert.rejects(adapter.step(row, context), error => error instanceof ProvisionFailure && error.code === 'provision_fenced');
    assert.equal(posts, 0); assert.equal(f.sqlite.inventory(row.identity)?.attempts, 0);
  } finally { f.close(); }
});

test('checkpoint overview SQL contract: SQLite and MySQL global blockers match', async () => {
  const f = fixture();
  try {
    f.db.prepare("UPDATE enterprise_pool_policy SET state='draining'").run();
    f.db.prepare('UPDATE user_pool_settings SET paused=1,idle_target=5,next_ordinal=10000').run();
    assert.deepEqual((await f.mysql.enterpriseOverview()).blockedReasons, f.sqlite.enterpriseOverview().blockedReasons);
  } finally { f.close(); }
});
