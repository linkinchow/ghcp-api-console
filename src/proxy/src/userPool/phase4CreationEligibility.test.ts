import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { parseEnterpriseRegistryV3 } from '@ghcp/shared';
import { enterpriseProfileIdentityHashV4 } from '@ghcp/shared/enterpriseRuntimeV4';
import { enterpriseRegistryHashV3 } from '@ghcp/shared/enterpriseRuntimeV3';
import { initEnterpriseSqliteV4 } from '@ghcp/shared/enterpriseStorageV4';
import { A, B, profileV3, poolOptionsV3 } from './mysqlPhase4.fixture.js';
import { MysqlPoolStore } from './mysqlStore.js';
import { UserPoolStore } from './store.js';
import { type PoolConfig, UserPoolError } from './config.js';
import { accountName, NAME_CAPACITY } from './names.js';

const C = '33333333-3333-4333-8333-333333333333', NOW = 1800000000000;
const options: PoolConfig = { enabled: true, accountDomain: profileV3(A).accountDomain, idleTarget: 1, maxAccounts: 11,
  leaseSeconds: 600, provisionalSeconds: 30, pollMs: 1000, retryAfterSeconds: 1, warmupModel: 'synthetic', requestTimeoutMs: 1000 };
function fixture() {
  const third = JSON.parse(JSON.stringify(profileV3(B)).replaceAll(B, C).replaceAll('other-corp', 'third-corp'));
  third.shortcode = 'thr';
  const registry = parseEnterpriseRegistryV3({ version: 3, registryRevision: 1, legacyEnterpriseId: A,
    profiles: [profileV3(A), profileV3(B), third].map((profile, i) => ({ ...profile, maxAccounts: [9, 1, 1][i] })) });
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  initEnterpriseSqliteV4(db, 'proxy', registry, poolOptionsV3());
  for (const profile of registry.profiles) {
    const binding = { enterpriseId: profile.id, enterpriseRevision: 1, profileIdentitySha256: enterpriseProfileIdentityHashV4(profile),
      registryRevision: 1, registrySha256: enterpriseRegistryHashV3(registry), legacyEnterpriseId: A };
    const probe = { ...binding, probeVersion: 1, schemaVersion: 3, contractVersion: 2,
      capability: 'enterprise-isolation-legacy-pool', ready: true, blockers: [] };
    const evidence = { ...binding, version: 1, checkedAt: NOW, sso: { ...probe, component: 'sso' }, login: { ...probe, component: 'login' } };
    db.prepare(`UPDATE enterprise_pool_policy SET state='active',validation_kind='local_service_readiness_v1',
      validation_evidence_json=?,validated_at=?,updated_at=? WHERE enterprise_id=?`).run(JSON.stringify(evidence), NOW, NOW, profile.id);
  }
  db.prepare("UPDATE user_pool_settings SET paused=0,owner='owner',owner_until=?").run(NOW + 30000);
  const sqlite = new UserPoolStore(db, options, registry); sqlite.now = () => NOW;
  const trace: string[] = [], hooks: { acquire?: () => void } = {};
  // SQL emulation only; no mysql driver/runtime connection or actual MySQL locks.
  const pool = { async getConnection() {
    hooks.acquire?.();
    const query = async (raw: string, values: unknown[] = []) => {
      trace.push(raw);
      if (raw.startsWith('SELECT TIMESTAMPDIFF')) return [[{ now: NOW }]];
      if (raw.startsWith('SET TRANSACTION')) return [{ affectedRows: 0 }];
      let sql = raw.replace(/\(TIMESTAMPDIFF\(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP\(3\)\) DIV 1000\)/g, String(NOW))
        .replace(/ FOR (UPDATE|SHARE)( SKIP LOCKED)?/g, '').replace(/LEAST\(/g, 'MIN(');
      if (/^DELETE h FROM user_pool_holds/.test(sql)) {
        sql = 'DELETE FROM user_pool_holds WHERE lease_id IN (SELECT lease_id FROM user_pool_leases WHERE member_identity=?) AND expires_at<=?';
      }
      if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/.test(sql)) { db.exec(sql); return [{ affectedRows: 0 }]; }
      if (/^\s*SELECT/.test(sql)) return [db.prepare(sql).all(...values)];
      return [{ affectedRows: db.prepare(sql).run(...values).changes }];
    };
    return { query, execute: query, beginTransaction: () => query('BEGIN'), commit: () => query('COMMIT'),
      rollback: () => query('ROLLBACK'), destroy() {}, release() {} } as unknown as PoolConnection;
  } } as unknown as Pool;
  const mysql = new MysqlPoolStore(pool, options, registry);
  let ordinal = 0;
  const seed = (id: string, state = 'failed') => {
    const identity = `synthetic-${ordinal}`, timestamp = new Date(NOW).toISOString();
    db.prepare(`INSERT INTO proxy_accounts(enterprise_id,account_incarnation,identity,sso_user,copilot_oauth_status,created_at,updated_at)
      VALUES(?,?,?,?,'missing',?,?)`).run(id, randomUUID(), identity, identity, timestamp, timestamp);
    db.prepare(`INSERT INTO user_pool_accounts(identity,ordinal,state,stage,attempt_id,attempts,updated_at)
      VALUES(?,?,?,'new',?,3,?)`).run(identity, ordinal++, state, randomUUID(), NOW);
    db.prepare('UPDATE user_pool_settings SET next_ordinal=?').run(ordinal);
    return identity;
  };
  return { db, mysql, sqlite, registry, pool, seed, trace, hooks, close: () => db.close() };
}

for (const backend of ['sqlite', 'mysql'] as const) {
  test(`global catalog ${backend}: one cursor across enterprises, collisions, restarts, drain, TTL and exhaustion`, async () => {
    const f = fixture();
    try {
      let store: UserPoolStore | MysqlPoolStore = f[backend];
      f.db.prepare('UPDATE enterprise_profiles SET max_accounts=10').run();
      f.db.prepare('UPDATE user_pool_settings SET idle_target=6').run();
      const stamp = new Date(NOW).toISOString();
      f.db.prepare(`INSERT INTO proxy_accounts(enterprise_id,account_incarnation,identity,sso_user,copilot_oauth_status,created_at,updated_at)
        VALUES(?,?,?,?,'missing',?,?)`).run(B, randomUUID(), 'direct-collision', accountName(0).toUpperCase(), stamp, stamp);
      for (const [index, id] of [A, B, A, B].entries()) {
        f.db.prepare('UPDATE user_pool_settings SET idle_target=?').run(index + 1);
        assert.equal(await store.reserveDeficit('owner', [id]), 1);
        if (index === 1) {
          store = backend === 'sqlite' ? new UserPoolStore(f.db, options, f.registry) : new MysqlPoolStore(f.pool, options, f.registry);
          if (backend === 'sqlite') (store as UserPoolStore).now = () => NOW;
        }
      }
      const inventory = f.db.prepare(`SELECT p.identity,p.ordinal,a.enterprise_id FROM user_pool_accounts p
        JOIN proxy_accounts a ON a.identity=p.identity ORDER BY p.ordinal`).all() as { identity: string; ordinal: number; enterprise_id: string }[];
      assert.deepEqual(inventory.map(row => row.ordinal), [1, 2, 3, 4]);
      assert.deepEqual(inventory.map(row => row.identity), [1, 2, 3, 4].map(accountName));
      assert.equal(new Set(inventory.map(row => row.identity)).size, 4);
      assert.deepEqual(inventory.map(row => row.enterprise_id), [A, B, A, B]);
      assert.equal((await store.accounts(A)).length, 2); assert.equal((await store.accounts(B)).length, 2);
      const a = inventory[0];
      f.db.prepare("UPDATE proxy_accounts SET copilot_oauth_token='synthetic',copilot_oauth_status='valid' WHERE identity=?").run(a.identity);
      f.db.prepare("UPDATE user_pool_accounts SET state='ready',stage='ready',verified_at=? WHERE identity=?").run(NOW, a.identity);
      f.db.prepare(`INSERT INTO user_pool_leases(caller_id,member_identity,lease_id,phase,assigned_at,last_success_at,expires_at)
        VALUES(?,?,?,'active',?,?,?)`).run(`sha256:${'b'.repeat(64)}`, a.identity, randomUUID(), NOW - 2000, NOW - 2000, NOW - 1);
      await store.reclaim();
      await store.updateEnterprisePolicy(A, 1, { type: 'cap', maxAccounts: 1 });
      await store.updateEnterprisePolicy(A, 2, { type: 'drain' });
      f.db.prepare('UPDATE user_pool_settings SET idle_target=6').run();
      assert.equal(await store.reserveDeficit('owner', [B]), 4, 'drained supply excluded but existing names never reused');
      assert.equal((await store.counts()).total, 8);
      const after = await store.enterpriseOverview(); assert.equal(after.names.nextOrdinal, 9);
      assert.equal(new Set((await store.accounts()).map(row => (row as { identity: string }).identity)).size, 8);
      f.db.prepare('UPDATE user_pool_settings SET next_ordinal=?,idle_target=7').run(NAME_CAPACITY - 1);
      assert.equal(await store.reserveDeficit('owner', [B]), 1);
      assert.equal((await store.inventory(accountName(NAME_CAPACITY - 1)))?.ordinal, NAME_CAPACITY - 1);
      f.db.prepare('UPDATE user_pool_settings SET idle_target=8').run();
      assert.equal(await store.reserveDeficit('owner', [B]), 0);
      assert.equal((await store.enterpriseOverview()).names.nextOrdinal, NAME_CAPACITY);
      assert.equal((await store.enterpriseOverview()).names.remainingPositions, 0);
    } finally { f.close(); }
  });

  test(`creation eligibility ${backend}: excluded unhealthy B stays in score denominator and all-state inventory`, async () => {
    const f = fixture();
    try {
      f.seed(A); for (let i = 0; i < 9; i++) f.seed(B, i % 2 ? 'disabled' : 'failed');
      assert.equal(await f[backend].reserveDeficit('owner', [A, C]), 1);
      const created = f.db.prepare("SELECT a.enterprise_id FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity WHERE p.state='provisioning'").all();
      assert.deepEqual(created, [{ enterprise_id: A }], 'full E: A score79 > C score10; removing unhealthy B would incorrectly select C');
      assert.equal((await f[backend].counts(B)).total, 9);
      assert.equal(await f[backend].reserveDeficit('owner', [A, C]), 0, 'I+P=T prevents ratio-only additions');
    } finally { f.close(); }
  });
  test(`creation eligibility ${backend}: confirmed full-SSO rejection cannot suppress healthy peer deficit or require manual reconciliation`, async () => {
    const f = fixture();
    try {
      const store = f[backend];
      assert.equal(await store.reserveDeficit('owner', [A]), 1);
      const identity = (await store.accounts(A))[0] as { identity: string };
      const row = (await store.inventory(identity.identity))!;
      await store.fail(row.identity, 'sso_user_limit_reached', row, 'owner', true);
      assert.equal((await store.inventory(row.identity))!.attempts, 3);
      assert.equal((await store.enterpriseOverview()).supply.pendingSupply, 0);
      assert.equal((await store.enterpriseOverview()).supply.deficit, 1);
      assert.equal(await store.reserveDeficit('owner', [B]), 1);
      assert.equal((await store.counts(A)).total, 1); assert.equal((await store.counts(B)).total, 1);
      for (let i = 0; i < 3; i++) assert.equal(await store.reserveDeficit('owner', [B]), 0);
      assert.equal((await store.enterpriseOverview()).supply.deficit, 0);
      assert.equal((await store.enterpriseOverview()).names.nextOrdinal, 2);
      await store.retry(row.identity, A);
      const retried = (await store.inventory(row.identity))!;
      assert.equal(retried.identity, row.identity); assert.equal(retried.ordinal, row.ordinal);
      assert.equal(retried.stage, 'new'); assert.equal(retried.attempts, 0);
      assert.equal((await store.enterpriseOverview()).names.nextOrdinal, 2);
    } finally { f.close(); }
  });

  test(`creation eligibility ${backend}: explicit empty excludes all without consuming names; undefined keeps existing contract`, async () => {
    const f = fixture();
    try {
      assert.equal(await f[backend].reserveDeficit('owner', []), 0);
      assert.equal((await f[backend].counts()).total, 0);
      assert.equal((f.db.prepare('SELECT next_ordinal FROM user_pool_settings').get() as { next_ordinal: number }).next_ordinal, 0);
      assert.equal(await f[backend].reserveDeficit('owner'), 1);
      assert.equal((await f[backend].accounts()).length, 1);
    } finally { f.close(); }
  });
  test(`creation eligibility ${backend}: strict unique registered IDs, no mutation on invalid input`, async () => {
    const f = fixture();
    try {
      for (const ids of [[A, A], ['not-a-uuid'], ['44444444-4444-4444-8444-444444444444'], [1], null, 'all']) {
        await assert.rejects(async () => f[backend].reserveDeficit('owner', ids as unknown as readonly string[]),
          error => error instanceof UserPoolError && error.code === 'invalid_enterprise_eligibility');
      }
      assert.equal((await f[backend].counts()).total, 0);
      assert.equal((f.db.prepare('SELECT next_ordinal FROM user_pool_settings').get() as { next_ordinal: number }).next_ordinal, 0);
    } finally { f.close(); }
  });
  test(`creation eligibility ${backend}: stale probe eligibility cannot bypass cap or draining CAS`, async () => {
    const f = fixture();
    try {
      const store = f[backend], eligible = [A, C];
      f.seed(A);
      await store.updateEnterprisePolicy(A, 1, { type: 'cap', maxAccounts: 1 });
      assert.equal(await store.reserveDeficit('owner', eligible), 1, 'fallback to eligible C, not full A or unverified B');
      assert.equal((await store.counts(A)).total, 1); assert.equal((await store.counts(C)).total, 1);
      f.db.prepare('UPDATE user_pool_settings SET idle_target=2').run();
      await store.updateEnterprisePolicy(A, 2, { type: 'drain' });
      assert.equal(await store.reserveDeficit('owner', eligible), 0);
      assert.equal((await store.counts(B)).total, 0);
      if (backend === 'mysql') {
        const settings = f.trace.findIndex(sql => /user_pool_settings.*FOR UPDATE/.test(sql));
        const policy = f.trace.findIndex(sql => /enterprise_pool_policy.*FOR SHARE/.test(sql));
        const insert = f.trace.findIndex(sql => /INSERT INTO proxy_accounts/.test(sql));
        assert.ok(settings >= 0 && settings < policy && policy < insert);
      }
    } finally { f.close(); }
  });
  test(`creation eligibility ${backend}: excluded enterprise supply still satisfies global target`, async () => {
    const f = fixture();
    try {
      const identity = f.seed(B);
      f.db.prepare("UPDATE user_pool_accounts SET state='provisioning',attempts=0 WHERE identity=?").run(identity);
      assert.equal(await f[backend].reserveDeficit('owner', [A, C]), 0);
      assert.equal((await f[backend].counts()).total, 1);
    } finally { f.close(); }
  });
}

test('creation eligibility mysql: copy supplied list before asynchronous connection acquisition', async () => {
  const f = fixture();
  try {
    const ids = [C];
    f.hooks.acquire = () => { ids.splice(0, 1, A); };
    assert.equal(await f.mysql.reserveDeficit('owner', ids), 1);
    assert.equal((await f.mysql.counts(C)).total, 1);
    assert.equal((await f.mysql.counts(A)).total, 0);
  } finally { f.close(); }
});
