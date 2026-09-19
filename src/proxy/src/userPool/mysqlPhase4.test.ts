import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { parseEnterpriseRegistryV3, type EnterpriseRegistryV3, type EnterpriseValidationEvidenceV1 } from '@ghcp/shared';
import { enterpriseRegistryHashV3 } from '@ghcp/shared/enterpriseRuntimeV3';
import { enterpriseProfileIdentityHashV4 } from '@ghcp/shared/enterpriseRuntimeV4';
import { initEnterpriseSqliteV4 } from '@ghcp/shared/enterpriseStorageV4';
import { A, B, profileV3, registryV3, poolOptionsV3 } from './mysqlPhase4.fixture.js';
import { MysqlPoolStore } from './mysqlStore.js';
import { UserPoolStore } from './store.js';
import { type PoolConfig, UserPoolError } from './config.js';
import { mysqlCallerGateStats } from './mysqlCallerGate.js';

const NOW = 1800000000000;
const C = '33333333-3333-4333-8333-333333333333';
const options: PoolConfig = { enabled: true, accountDomain: profileV3(A).accountDomain, idleTarget: 10, maxAccounts: 10,
  leaseSeconds: 600, provisionalSeconds: 30, pollMs: 1000, retryAfterSeconds: 1, warmupModel: 'synthetic', requestTimeoutMs: 1000 };
const caller = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;
const code = (expected: string) => (error: unknown) => error instanceof UserPoolError && error.code === expected;
function registry(caps: number[]): EnterpriseRegistryV3 {
  const base = registryV3();
  const profiles = [profileV3(A), profileV3(B)];
  if (caps.length === 3) {
    const third = JSON.parse(JSON.stringify(profileV3(B)).replaceAll(B, C).replaceAll('other-corp', 'third-corp'));
    third.shortcode = 'thr';
    profiles.push(third);
  }
  return parseEnterpriseRegistryV3({ ...base, profiles: profiles.slice(0, caps.length).map((profile, i) => ({ ...profile, maxAccounts: caps[i] })) });
}
function evidence(reg: EnterpriseRegistryV3, id: string, now = NOW): EnterpriseValidationEvidenceV1 {
  const profile = reg.profiles.find(row => row.id === id)!;
  const binding = { enterpriseId: id, enterpriseRevision: profile.revision,
    profileIdentitySha256: enterpriseProfileIdentityHashV4(profile), registryRevision: reg.registryRevision,
    registrySha256: enterpriseRegistryHashV3(reg), legacyEnterpriseId: reg.legacyEnterpriseId };
  const probe = { probeVersion: 1 as const, schemaVersion: 3, contractVersion: 2 as const,
    capability: 'enterprise-isolation-legacy-pool', ready: true, blockers: [], ...binding };
  return { version: 1, ...binding, checkedAt: now,
    sso: { ...probe, component: 'sso' }, login: { ...probe, component: 'login' } };
}

/**
 * SQL contract emulator only, NOT MySQL execution/locking proof. Production
 * MySQL queries run against synthetic SQLite after explicit dialect rewrites;
 * query traces assert lock ordering, CAS, policy boundaries, and no replay.
 * No mysql2 runtime import, environment loading, socket, or external request.
 */
function fixture(caps = [9, 1]) {
  const reg = registry(caps);
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  initEnterpriseSqliteV4(db, 'proxy', reg, poolOptionsV3());
  db.prepare('UPDATE user_pool_settings SET paused=0,idle_target=?,owner=?,owner_until=?').run(caps.reduce((n, x) => n + x, 0), 'owner', NOW + 30000);
  for (const profile of reg.profiles) {
    const proof = evidence(reg, profile.id);
    db.prepare(`UPDATE enterprise_pool_policy SET state='active',validation_kind='local_service_readiness_v1',
      validation_evidence_json=?,validated_at=?,updated_at=? WHERE enterprise_id=?`).run(JSON.stringify(proof), NOW, NOW, profile.id);
  }
  const trace: { sql: string; values: unknown[] }[] = [];
  const counts = { commits: 0, acquisitions: 0, destroyed: 0, released: 0 };
  const hooks: { query?: (sql: string, values: unknown[]) => void | Promise<void> } = {};
  const pool = { async getConnection() {
    counts.acquisitions++;
    const query = async (raw: string, values: unknown[] = []) => {
      trace.push({ sql: raw, values });
      await hooks.query?.(raw, values);
      if (raw.includes('DATABASE()')) return [[{ name: 'sql_contract_only' }]];
      if (raw.includes('GET_LOCK')) return [[{ acquired: 1 }]];
      if (raw.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
      if (raw.startsWith('SELECT TIMESTAMPDIFF')) return [[{ now: NOW }]];
      if (raw.startsWith('SET TRANSACTION')) return [{ affectedRows: 0 }];
      let sql = raw.replace(/\(TIMESTAMPDIFF\(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP\(3\)\) DIV 1000\)/g, String(NOW))
        .replace(/ FORCE INDEX \(idx_user_pool_available\)/g, '').replace(/ FOR (UPDATE|SHARE)( SKIP LOCKED)?/g, '');
      if (/^DELETE h FROM user_pool_holds/.test(sql)) {
        sql = 'DELETE FROM user_pool_holds WHERE lease_id IN (SELECT lease_id FROM user_pool_leases WHERE member_identity=?) AND expires_at<=?';
      }
      if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/.test(sql)) { db.exec(sql); return [{ affectedRows: 0 }]; }
      if (/^\s*SELECT\b/.test(sql)) return [db.prepare(sql).all(...values)];
      return [{ affectedRows: db.prepare(sql).run(...values).changes }];
    };
    return { query, execute: query, beginTransaction: () => query('BEGIN'),
      commit: async () => { counts.commits++; await query('COMMIT'); }, rollback: () => query('ROLLBACK'),
      destroy: () => { counts.destroyed++; }, release: () => { counts.released++; } } as unknown as PoolConnection;
  } } as unknown as Pool;
  const mysql = new MysqlPoolStore(pool, options, reg);
  // initialize's actual MySQL information_schema validator is intentionally not
  // simulated. The fixture initializes the exact v4 synthetic schema above.
  Object.assign(mysql, { enterpriseId: A, registry: reg });
  const sqlite = new UserPoolStore(db, options, reg);
  sqlite.now = () => NOW;
  let ordinal = 0;
  const seed = (id: string, state = 'ready', stage = state === 'ready' ? 'ready' : 'new') => {
    const identity = `synthetic_${ordinal}`;
    db.prepare(`INSERT INTO proxy_accounts(enterprise_id,account_incarnation,identity,sso_user,copilot_oauth_status,copilot_oauth_token,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, randomUUID(), identity, identity, state === 'ready' ? 'valid' : 'missing', state === 'ready' ? 'synthetic-token' : null,
      new Date(NOW).toISOString(), new Date(NOW).toISOString());
    db.prepare(`INSERT INTO user_pool_accounts(identity,ordinal,state,stage,attempt_id,attempts,verified_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(identity, ordinal++, state, stage, randomUUID(), state === 'failed' ? 3 : 0, state === 'ready' ? NOW : null, NOW);
    db.prepare('UPDATE user_pool_settings SET next_ordinal=?').run(ordinal);
    return identity;
  };
  return { mysql, sqlite, pool, db, reg, seed, trace, counts, hooks, close: () => db.close() };
}

test('MySQL policy mapping reuses the bounded evidence parser, including padded valid JSON', async () => {
  const f = fixture();
  try {
    const policy = (await f.mysql.enterpriseOverview()).enterprises[0];
    assert.equal(policy.enterpriseId, A);
    const valid = JSON.stringify(evidence(f.reg, A));
    // MySQL JSON/text rows still require the same application-level length bound;
    // SQLite's schema CHECK would otherwise stop this corrupt-row fixture first.
    f.db.pragma('ignore_check_constraints=ON');
    for (const malformed of [valid + ' '.repeat(16385), '{', JSON.stringify({ ...evidence(f.reg, A), secret: 'not-allowed' })]) {
      f.db.prepare('UPDATE enterprise_pool_policy SET validation_evidence_json=? WHERE enterprise_id=?').run(malformed, A);
      await assert.rejects(f.mysql.enterpriseOverview(), /enterprise_pool_contract_invalid/);
      assert.throws(() => f.sqlite.enterpriseOverview(), /enterprise_pool_contract_invalid/);
    }
    f.db.prepare('UPDATE enterprise_pool_policy SET validation_evidence_json=? WHERE enterprise_id=?').run(valid, A);
    assert.equal((await f.mysql.enterpriseOverview()).enterprises[0].enterpriseId, A);
  } finally { f.close(); }
});

test('phase4 MySQL SQL contract: exact current-share creation arithmetic 9/1 at 1/0, not N+1', async () => {
  const f = fixture();
  try {
    f.seed(A, 'failed');
    const next = await f.mysql.reserve();
    assert.equal(next?.enterprise_id, B);
    assert.equal(next?.enterprise_revision, 1);
    const gate = f.trace.findIndex(row => /user_pool_settings WHERE id=1 FOR UPDATE/.test(row.sql));
    const policy = f.trace.findIndex(row => /enterprise_pool_policy WHERE enterprise_id=\? FOR SHARE/.test(row.sql));
    const insert = f.trace.findIndex(row => /INSERT INTO proxy_accounts/.test(row.sql));
    assert.ok(gate >= 0 && gate < policy && policy < insert);
    assert.equal(f.trace.filter(row => /enterprise_pool_policy.*FOR UPDATE/s.test(row.sql)).length, 0);
  } finally { f.close(); }
});

test('phase4 MySQL SQL contract: empty 500/300/200 pool recomputes each insert and stops at T50', async () => {
  const f = fixture([500, 300, 200]);
  try {
    f.db.prepare('UPDATE user_pool_settings SET idle_target=50').run();
    assert.equal(await f.mysql.reserveDeficit('owner'), 32);
    assert.equal(await f.mysql.reserveDeficit('owner'), 18);
    assert.equal(await f.mysql.reserveDeficit('owner'), 0);
    const overview = await f.mysql.enterpriseOverview();
    assert.deepEqual(overview.enterprises.map(row => row.counts.total), [25, 15, 10]);
    assert.equal(overview.supply.pendingSupply, 50);
    assert.equal(overview.supply.deficit, 0);
  } finally { f.close(); }
});

test('phase4 MySQL SQL contract: admission 600/300/100 at 50/23/27 selects A, policy locks last', async () => {
  const f = fixture([600, 300, 100]);
  try {
    [A, B, C].forEach((id, i) => { for (let n = 0; n < [50, 23, 27][i]; n++) f.seed(id); });
    const held = await f.mysql.acquire(caller(1));
    assert.equal(held.enterprise_id, A);
    const policy = f.trace.findIndex(row => /enterprise_pool_policy WHERE enterprise_id=\? FOR SHARE/.test(row.sql));
    const accountLocks = f.trace.flatMap((row, i) => /FROM proxy_accounts WHERE identity=.*FOR UPDATE/.test(row.sql) ? [i] : []);
    assert.ok(accountLocks.length > 0 && accountLocks.every(i => i < policy));
    assert.ok(f.trace.some(row => /FOR UPDATE SKIP LOCKED/.test(row.sql)));
    assert.equal(f.trace.some(row => /user_pool_settings.*FOR UPDATE/s.test(row.sql)), false);
    assert.equal(f.trace.some(row => /FOR SHARE/.test(row.sql) && /JOIN/.test(row.sql)), false);
    assert.equal(f.trace.filter(row => /GET_LOCK/.test(row.sql)).length, 1);
    assert.deepEqual(mysqlCallerGateStats(f.pool), { retainedTickets: 0, scopes: 0, active: 0, queued: 0 });
  } finally { f.close(); }
});

test('phase4 MySQL SQL contract: durable events, scopes, membership and actions never cross enterprises', async () => {
  const f = fixture([5, 5]);
  try {
    const a = f.seed(A), b = f.seed(B);
    await f.mysql.event('synthetic_member_event', b);
    await f.mysql.event('synthetic_platform_event');
    assert.equal((await f.mysql.events(A)).length, 0);
    assert.equal((await f.mysql.events(B)).length, 1);
    assert.equal((await f.mysql.events()).length, 2);
    assert.equal(await f.mysql.managesSsoUser(b), false);
    assert.equal(await f.mysql.managesSsoUser(b.toUpperCase(), B), true);
    assert.equal((await f.mysql.page('accounts', { page: 1, pageSize: 1, enterpriseId: B })).total, 1);
    assert.equal((await f.mysql.page('events', { page: 1, pageSize: 20, enterpriseId: A })).total, 0);
    assert.equal((await f.mysql.accounts(A)).length, 1);
    await assert.rejects(f.mysql.disable(b, A), code('member_not_found'));
    await assert.rejects(f.mysql.retry(b, A), code('member_not_found'));
    const lease = await f.mysql.acquire(caller(2));
    const wrong = lease.enterprise_id === A ? B : A;
    await assert.rejects(f.mysql.release(lease.lease_id, wrong), code('lease_not_found'));
    assert.equal((await f.mysql.inventory(a))?.enterprise_id, A);
    assert.equal((await f.mysql.inventory(b))?.state, 'ready');
    await f.mysql.finish(lease, false);
    await f.mysql.release(lease.lease_id, lease.enterprise_id);
    const page = await f.mysql.page('leases', { page: 1, pageSize: 20, enterpriseId: wrong });
    assert.equal(page.total, 0);
  } finally { f.close(); }
});

test('phase4 MySQL SQL contract: global settings derived, cap CAS locks policy only and never evicts', async () => {
  const f = fixture([5, 5]);
  try {
    for (let i = 0; i < 3; i++) f.seed(A);
    await assert.rejects(f.mysql.updateSettings(1, { max_accounts: 1 }), code('invalid_pool_settings'));
    await f.mysql.updateSettings(1, { idle_target: 10000 });
    f.trace.length = 0;
    const changed = await f.mysql.updateEnterprisePolicy(A, 1, { type: 'cap', maxAccounts: 1 });
    assert.equal(changed.policyVersion, 2);
    const lock = f.trace.findIndex(row => /enterprise_pool_policy.*FOR UPDATE/.test(row.sql));
    assert.ok(lock > f.trace.findIndex(row => /user_pool_settings.*FOR UPDATE/.test(row.sql)));
    assert.equal(f.trace[lock].sql.includes('JOIN'), false);
    assert.equal(f.trace.some(row => /user_pool_accounts|proxy_accounts|user_pool_(leases|holds|catalog_holds|events)/.test(row.sql)), false);
    assert.equal((await f.mysql.settings()).max_accounts, 6);
    assert.equal((await f.mysql.settings()).active_max_accounts, 6);
    assert.equal((await f.mysql.inventory('synthetic_0'))?.state, 'ready');
    await assert.rejects(f.mysql.updateEnterprisePolicy(A, 1, { type: 'drain' }), code('policy_version_conflict'));
    await assert.rejects(f.mysql.updateEnterprisePolicy(A, 2, { type: 'cap', maxAccounts: 0 }), code('invalid_enterprise_policy'));
    await assert.rejects(f.mysql.updateEnterprisePolicy(A, 2, { type: 'cap', maxAccounts: 10000 }), code('invalid_enterprise_policy'));
    assert.equal((await f.mysql.enterpriseOverview()).enterprises[0].overCap, true);
  } finally { f.close(); }
});

test('phase4 MySQL SQL contract: draining keeps valid inference lease, rejects every new catalog and catalog-only inference', async () => {
  const f = fixture([5, 5]);
  try {
    f.seed(A); f.seed(A); f.seed(B);
    const live = await f.mysql.acquire(caller(3));
    await f.mysql.finish(live, true);
    const catalog = await f.mysql.acquireCatalog(caller(4));
    for (const id of [A, B]) await f.mysql.updateEnterprisePolicy(id, 1, { type: 'drain' });
    f.trace.length = 0;
    const continued = await f.mysql.acquire(caller(3));
    assert.equal(continued.lease_id, live.lease_id);
    assert.equal(f.trace.some(row => /FOR SHARE/.test(row.sql)), false);
    await assert.rejects(f.mysql.acquireCatalog(caller(3)), code('enterprise_not_active'));
    await assert.rejects(f.mysql.acquire(caller(4)), code('enterprise_not_active'));
    assert.equal((await f.mysql.inventory(catalog.member_identity))?.enterprise_id, catalog.enterprise_id);
    assert.equal(await f.mysql.reserve(), undefined);
    await f.mysql.finish(continued, true);
    await f.mysql.finish(catalog, false);
    assert.equal(await f.mysql.canProvision(live.member_identity), true);
  } finally { f.close(); }
});

test('phase4 MySQL SQL contract: lifecycle actions strict evidence and monotone CAS', async () => {
  const f = fixture();
  try {
    await f.mysql.updateEnterprisePolicy(B, 1, { type: 'drain' });
    await assert.rejects(f.mysql.updateEnterprisePolicy(B, 2, { type: 'activate', evidence: evidence(f.reg, B) }), code('invalid_policy_transition'));
    await assert.rejects(f.mysql.updateEnterprisePolicy(B, 2, { type: 'validate', evidence: evidence(f.reg, A) }), code('invalid_readiness_evidence'));
    await assert.rejects(f.mysql.updateEnterprisePolicy(B, 2, { type: 'validate', evidence: evidence(f.reg, B, NOW - 300001) }), code('invalid_readiness_evidence'));
    const validated = await f.mysql.updateEnterprisePolicy(B, 2, { type: 'validate', evidence: evidence(f.reg, B) });
    assert.equal(validated.state, 'validated');
    const active = await f.mysql.updateEnterprisePolicy(B, 3, { type: 'activate', evidence: evidence(f.reg, B) });
    assert.equal(active.state, 'active');
    assert.equal(active.policyVersion, 4);
    assert.equal((await f.mysql.enterprisePolicies()).length, 2);
  } finally { f.close(); }
});

test('phase4 MySQL SQL contract: logical summary matches SQLite, retains blocked active denominator, and does not reclaim', async () => {
  const f = fixture([9, 1]);
  try {
    const idle = f.seed(A), pending = f.seed(A, 'provisioning'), blocked = f.seed(B, 'failed');
    f.db.prepare('UPDATE user_pool_accounts SET cooldown_until=?,state=? WHERE identity=?').run(NOW - 1, 'cooling', idle);
    f.db.prepare('INSERT INTO user_pool_leases VALUES(?,?,?,?,?,?,?)').run(caller(5), idle, randomUUID(), 'active', NOW - 100, NOW - 100, NOW - 1);
    const stale = evidence(f.reg, B);
    stale.profileIdentitySha256 = stale.sso.profileIdentitySha256 = stale.login.profileIdentitySha256 = 'f'.repeat(64);
    f.db.prepare('UPDATE enterprise_pool_policy SET identity_sha256=?,validation_evidence_json=? WHERE enterprise_id=?')
      .run('f'.repeat(64), JSON.stringify(stale), B);
    f.db.prepare('UPDATE user_pool_settings SET idle_target=2').run();
    f.trace.length = 0;
    const mysql = await f.mysql.enterpriseOverview();
    const sqlite = f.sqlite.enterpriseOverview();
    assert.deepEqual(mysql.supply, sqlite.supply);
    assert.deepEqual(mysql.enterprises.map(row => ({ id: row.enterpriseId, counts: row.counts, score: row.score })),
      sqlite.enterprises.map(row => ({ id: row.enterpriseId, counts: row.counts, score: row.score })));
    assert.equal(mysql.enterprises[0].score, 7);
    assert.equal(mysql.supply.eligibleIdle, 1);
    assert.equal(mysql.supply.pendingSupply, 1);
    assert.equal(mysql.supply.deficit, 0);
    assert.equal(f.trace.some(row => /^(UPDATE|DELETE|INSERT)/.test(row.sql) || /FOR UPDATE|FOR SHARE/.test(row.sql)), false);
    assert.equal(await f.mysql.reserve(), undefined, 'no extra build while I+P=T despite a zero/blocked enterprise');
    assert.equal((await f.mysql.inventory(idle))?.state, 'cooling', 'summary/reserve do not physically reclaim');
    assert.equal((await f.mysql.inventory(pending))?.state, 'provisioning');
    assert.equal((await f.mysql.inventory(blocked))?.state, 'failed');
  } finally { f.close(); }
});

test('phase4 MySQL SQL contract: draining credential begin blocked before account lock, observe permits dispatched evidence', async () => {
  const f = fixture();
  try {
    const member = f.seed(B, 'provisioning', 'oauth-starting');
    await f.mysql.updateEnterprisePolicy(B, 1, { type: 'drain' });
    assert.equal(await f.mysql.canProvision(member), false);
    f.db.prepare("UPDATE user_pool_accounts SET stage='oauth-dispatch' WHERE identity=?").run(member);
    assert.equal(await f.mysql.canProvision(member, 'observe'), true);
    assert.equal(await f.mysql.canProvision(member, 'advance'), false);
    const row = (await f.mysql.inventory(member))!;
    f.trace.length = 0;
    assert.equal(await f.mysql.mutateWorkerCredential(member, row, 'owner', { type: 'begin', oauthAttemptId: randomUUID() }), false);
    assert.equal(f.trace.some(row => /proxy_accounts.*FOR UPDATE/s.test(row.sql)), false);
    const policy = f.trace.findIndex(row => /enterprise_pool_policy.*FOR SHARE/.test(row.sql));
    assert.ok(policy > f.trace.findIndex(row => /user_pool_settings.*FOR UPDATE/.test(row.sql)));
  } finally { f.close(); }
});

test('phase4 MySQL SQL contract: selected policy draining race rejects rather than locking another candidate', async () => {
  const f = fixture([5, 5]);
  try {
    f.seed(A); f.seed(B);
    f.hooks.query = (sql, values) => {
      if (/enterprise_pool_policy WHERE enterprise_id=\? FOR SHARE/.test(sql)) {
        f.db.prepare("UPDATE enterprise_pool_policy SET state='draining' WHERE enterprise_id=?").run(values[0]);
      }
    };
    await assert.rejects(f.mysql.acquire(caller(8)), code('enterprise_not_active'));
    const policy = f.trace.findIndex(row => /FOR SHARE/.test(row.sql));
    assert.equal(f.trace.slice(policy + 1).some(row => /proxy_accounts.*FOR UPDATE/s.test(row.sql)), false);
    assert.equal((await f.mysql.leases()).length, 0);
  } finally { f.close(); }
});

test('phase4 MySQL SQL contract: I/P dedup excludes live leases/holds, future cooldown and manual unknown work', async () => {
  const f = fixture([20, 20]);
  try {
    const idle = f.seed(A), cold = f.seed(A), repair = f.seed(A, 'provisioning');
    const leasedRepair = f.seed(A, 'provisioning'), manual = f.seed(A, 'provisioning');
    const unknown = f.seed(B, 'provisioning', 'sso-creating'), heldRepair = f.seed(B, 'provisioning');
    const invalidReady = f.seed(B);
    f.db.prepare("UPDATE user_pool_accounts SET state='cooling',cooldown_until=? WHERE identity=?").run(NOW + 10000, cold);
    f.db.prepare('UPDATE user_pool_accounts SET last_error=? WHERE identity=?').run('oauth_dispatch_ambiguous', manual);
    f.db.prepare('UPDATE user_pool_accounts SET verified_at=NULL WHERE identity=?').run(invalidReady);
    const leaseId = randomUUID();
    f.db.prepare('INSERT INTO user_pool_leases VALUES(?,?,?,?,?,?,?)')
      .run(caller(11), leasedRepair, leaseId, 'active', NOW, NOW, NOW + 10000);
    const oldLease = randomUUID();
    f.db.prepare('INSERT INTO user_pool_leases VALUES(?,?,?,?,?,?,?)')
      .run(caller(12), heldRepair, oldLease, 'provisional', NOW - 10000, null, NOW - 1);
    f.db.prepare('INSERT INTO user_pool_holds(request_id,lease_id,expires_at,deadline_at,generation) VALUES(?,?,?,?,?)')
      .run(randomUUID(), oldLease, NOW + 10000, NOW + 5000, 1);
    f.db.prepare('UPDATE user_pool_settings SET idle_target=3').run();
    const overview = await f.mysql.enterpriseOverview();
    assert.deepEqual(overview.supply, { eligibleIdle: 1, pendingSupply: 2, deficit: 0 });
    assert.deepEqual(overview.supply, f.sqlite.enterpriseOverview().supply);
    assert.equal(await f.mysql.reserve(), undefined);
    assert.equal((await f.mysql.counts()).total, 8);
    assert.ok([idle, repair, unknown].every(Boolean));
  } finally { f.close(); }
});

test('phase4 MySQL SQL contract: nonlegacy worker credential begin binds member enterprise and revision', async () => {
  const f = fixture();
  try {
    const identity = f.seed(B, 'provisioning', 'oauth-starting');
    f.db.prepare('UPDATE proxy_accounts SET gh_login=? WHERE identity=?').run('synthetic-gh', identity);
    const row = (await f.mysql.inventory(identity))!, attempt = randomUUID();
    assert.equal(await f.mysql.mutateWorkerCredential(identity, row, 'owner', { type: 'begin', oauthAttemptId: attempt }), true);
    const ledger = f.db.prepare('SELECT enterprise_id,enterprise_revision,oauth_attempt_id FROM proxy_authorization_attempts WHERE identity=?').get(identity);
    assert.deepEqual(ledger, { enterprise_id: B, enterprise_revision: 1, oauth_attempt_id: attempt });
    const policy = f.trace.findIndex(row => /FOR SHARE/.test(row.sql));
    const account = f.trace.findIndex(row => /proxy_accounts.*FOR UPDATE/s.test(row.sql));
    assert.ok(policy >= 0 && account > policy);
  } finally { f.close(); }
});

test('phase4 MySQL SQL contract: held enterprise/revision are authoritative and forged finish cannot release hold', async () => {
  const f = fixture();
  try {
    f.seed(A);
    const held = await f.mysql.acquire(caller(10));
    assert.equal(await f.mysql.heartbeat(held), true);
    assert.equal(await f.mysql.heartbeat({ ...held, enterprise_id: B }), false);
    assert.equal(await f.mysql.heartbeat({ ...held, enterprise_revision: 2 }), false);
    await f.mysql.finish({ ...held, enterprise_id: B }, true);
    assert.equal(await f.mysql.heartbeat(held), true);
    await f.mysql.finish(held, false);
    assert.equal(await f.mysql.heartbeat(held), false);
  } finally { f.close(); }
});

test('phase4 MySQL SQL contract: unknown COMMIT never replays or hands back a lock-owning socket', async () => {
  const f = fixture();
  try {
    f.seed(A);
    f.hooks.query = sql => { if (sql === 'COMMIT') throw Object.assign(new Error('lost commit acknowledgement'), { code: 'ER_LOCK_DEADLOCK' }); };
    await assert.rejects(f.mysql.acquire(caller(9)), /lost commit acknowledgement/);
    assert.equal(f.counts.commits, 1);
    assert.equal(f.counts.acquisitions, 1);
    assert.equal(f.counts.destroyed, 1);
    assert.deepEqual(mysqlCallerGateStats(f.pool), { retainedTickets: 0, scopes: 0, active: 0, queued: 0 });
  } finally { f.close(); }
});
