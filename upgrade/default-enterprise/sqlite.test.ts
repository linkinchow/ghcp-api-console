import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { EnterpriseProfile } from '../../src/packages/shared/src/enterprise.js';
import { initEnterpriseSqlite, validateEnterpriseSqlite, validateEnterpriseV1Sqlite, type EnterpriseLayout } from '../../src/packages/shared/src/enterpriseStorage.js';
import { createEnterpriseV1SqliteSchema } from '../../src/packages/shared/src/enterpriseSqliteV1.js';
import { accountName } from '../v1-frozen/userPool/names.js';
import { runEnterpriseCommand } from './commands.js';
import { parseEnterpriseManifest, type EnterpriseManifest, type SqliteService } from './manifest.js';
import { applyEnterpriseSqlite, initEnterpriseSqliteFile, inspectEnterpriseSqlite, preflightEnterpriseSqlite,
  readStandaloneSqlite, sha256, validateAdminsFile, verifyEnterpriseSqlite } from './sqlite.js';

const profile: EnterpriseProfile = { id: '84bdc214-ad8b-484f-9419-3d82b63d07c4', slug: 'synthetic-enterprise', shortcode: 'synth',
  accountDomain: 'fixture.invalid', revision: 1, routes: { proxyInternalUrl: 'http://127.0.0.1:14101', ssoInternalUrl: 'http://127.0.0.1:14102',
    loginInternalUrl: 'http://127.0.0.1:14103', ssoPublicUrl: 'https://sso.fixture.invalid' } };
const stamp = '2026-09-01T01:02:03.004Z';
const poolSettings = { version: 9, idle_target: 1, lease_seconds: 172800, paused: 1 as const,
  next_ordinal: 3, account_domain: profile.accountDomain, owner: 'old-owner', owner_until: 0 };
function fixture(layout: EnterpriseLayout): Database.Database {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); createEnterpriseV1SqliteSchema(db, layout);
  if (layout === 'direct' || layout === 'pool') {
    db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run('2026-07-23-copilot-oauth-direct', stamp);
    db.prepare('INSERT INTO proxy_accounts VALUES (?,?,?,?,?,?,?,?,?)').run(accountName(2), accountName(2), 'synthetic_synth', 'synthetic-secret-token', 'valid', stamp, null, stamp, stamp);
    db.prepare('INSERT INTO proxy_request_stats VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('stat-id', accountName(2), 'synthetic_synth', stamp, '/chat', 'fixture', 1, null, 11, 12, 13, 14, 15, null, null);
    if (layout === 'pool') {
      db.prepare('INSERT INTO user_pool_settings VALUES (1,?,?,?,?,?,?,?,?,?)').run(poolSettings.version, poolSettings.idle_target, 7, poolSettings.lease_seconds, 1, 3, profile.accountDomain, 'old-owner', 0);
      db.prepare(`INSERT INTO user_pool_accounts(identity,ordinal,state,stage,attempt_id,oauth_attempt_id,sso_created_at,task_id,updated_at,verified_at,generation,reauth_count,reauth_window_at)
        VALUES(?,2,'ready','ready',?,?,?, ?,1234,1230,17,2,1200)`).run(accountName(2), randomUUID(), randomUUID(), stamp, randomUUID());
      db.prepare("INSERT INTO user_pool_leases VALUES(?,?,?,'active',100,120,9999999999999)").run('sha256:' + 'a'.repeat(64), accountName(2), randomUUID());
      db.prepare('INSERT INTO user_pool_catalog_cooldowns VALUES(?,?,?)').run('sha256:' + 'b'.repeat(64), accountName(2), 9999999999999);
      db.prepare('INSERT INTO user_pool_events(id,at,action,identity,detail) VALUES(99,1234,?,?,?)').run('fixture', accountName(2), 'synthetic-history');
      db.exec('DELETE FROM user_pool_events'); // Sequence high-water must survive even for an empty table.
    }
  } else if (layout === 'sso') {
    db.prepare('INSERT INTO sso_users VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('synthetic_synth', 'synthetic-hash', 'synthetic-salt', 'synthetic@fixture.invalid', 'user', 'synthetic_synth', 'scim-id', 'synced', 'enabled', null, null, stamp, stamp, stamp);
    db.prepare('INSERT INTO sso_pool_managed_users VALUES(?)').run('synthetic_synth');
    db.prepare("INSERT INTO sso_runtime_settings VALUES(1,NULL,'user',?,3,250,3,1000,4,?)").run(profile.accountDomain, stamp);
    db.prepare('INSERT INTO sso_budget_cache VALUES(?,2026,9,1.25,?,?,?)').run('2026-09', 'unit', '{"synthetic":true}', stamp);
    db.prepare('INSERT INTO sso_emu_import_plans VALUES(?,?,?,?,?,?)').run('plan-id', 'synthetic_synth', 'applied', stamp, stamp, stamp);
    db.prepare('INSERT INTO sso_emu_import_plan_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('plan-id', 0, 'synthetic_synth', 'synthetic@fixture.invalid', 'synthetic_synth', 'scim-id', 'synced', 'enabled', 'success', 'historical-detail', 'link', stamp, stamp);
  } else {
    db.prepare("INSERT INTO login_tasks VALUES(?,?,?,?,?,?,'success',2,NULL,?,?,?,?)").run('task-id', accountName(2), 'synthetic_synth', 'synthetic_synth', 'historic-nonce', 'saml', '/synthetic/task.log', stamp, stamp, stamp);
    db.prepare('INSERT INTO login_runtime_settings VALUES(1,2,61000,1,0,6,?)').run(stamp);
  }
  return db;
}
function manifest(dir: string, layout: EnterpriseLayout = 'pool'): EnterpriseManifest {
  const services = (['proxy', 'sso', 'login'] as const).map(component => {
    const source = join(dir, `${component}-v1.sqlite`), target = join(dir, `${component}-v2.sqlite`);
    const selected = component === 'proxy' ? layout as 'pool' | 'direct' : component;
    const db = fixture(selected);
    try { writeFileSync(source, db.serialize()); } finally { db.close(); }
    return { component, driver: 'sqlite', layout: selected, source, target, backup: { reference: 'synthetic-offline-backup', sha256: sha256(readFileSync(source)) } };
  });
  return parseEnterpriseManifest({ manifestVersion: 1, baseline: '8ad76d5', profile, services,
    attestations: { writersStopped: true, externalOperationsDrained: true, backupVerified: true } });
}
function temporary(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'enterprise-synthetic-')); try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
for (const layout of ['direct', 'pool', 'sso', 'login'] as const) {
  test(`runtime gate: ${layout} empty/legacy rejected, explicit init validates, no second profile`, () => {
    const component = layout === 'direct' || layout === 'pool' ? 'proxy' : layout;
    const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    try {
      assert.throws(() => validateEnterpriseSqlite(db, component), /enterprise_init_required/);
      const state = initEnterpriseSqlite(db, component, profile, layout === 'pool' ? { layout, maxAccounts: 7, pool: { settings: poolSettings } } : { layout });
      assert.equal(state.profile.id, profile.id);
      assert.equal(state.layout, layout);
      assert.throws(() => db.prepare('INSERT OR REPLACE INTO enterprise_profiles SELECT * FROM enterprise_profiles').run(), /enterprise_profile_already_registered/);
      assert.throws(() => db.prepare('UPDATE enterprise_profiles SET id=?').run(randomUUID()), /enterprise_profile_immutable/);
      assert.throws(() => db.exec('DELETE FROM enterprise_profiles'), /enterprise_profile_required/);
      assert.throws(() => validateEnterpriseSqlite(db, component, { ...profile, revision: 2 }), /enterprise_profile_mismatch/);
    } finally { db.close(); }
    const old = fixture(layout);
    try { assert.equal(validateEnterpriseV1Sqlite(old, component), layout); assert.throws(() => validateEnterpriseSqlite(old, component), /enterprise_migrate_required/); }
    finally { old.close(); }
  });
}
for (const layout of ['direct', 'pool'] as const) {
  test(`offline ${layout} three-service migration preserves every source column and stays idempotent`, () => temporary(dir => {
    const plan = manifest(dir, layout);
    for (const item of plan.services) {
      const service = item as SqliteService;
      const before = readFileSync(service.source!);
      assert.equal(preflightEnterpriseSqlite(service, profile).state, 'preflight');
      assert.equal(applyEnterpriseSqlite(service, plan).state, 'complete');
      const targetBefore = readFileSync(service.target);
      assert.equal(verifyEnterpriseSqlite(service, plan).originalColumnsPreserved, true);
      assert.equal(applyEnterpriseSqlite(service, plan).state, 'already-complete');
      assert.deepEqual(readFileSync(service.target), targetBefore);
      assert.deepEqual(readFileSync(service.source!), before);
      assert.equal(inspectEnterpriseSqlite(service, profile).state, 'complete');
    }
    const proxy = readStandaloneSqlite((plan.services[0] as SqliteService).target).db;
    try {
      if (layout === 'pool') {
        assert.equal((proxy.prepare('SELECT max_accounts FROM enterprise_profiles').get() as { max_accounts: number }).max_accounts, 7);
        assert.ok(!(proxy.pragma('table_info(user_pool_settings)') as { name: string }[]).some(row => row.name === 'max_accounts'));
        assert.deepEqual(proxy.prepare('SELECT generation,verified_at FROM user_pool_accounts').get(), { generation: 17, verified_at: 1230 });
        proxy.prepare("UPDATE proxy_accounts SET copilot_oauth_token='changed-synthetic'").run();
        assert.deepEqual(proxy.prepare('SELECT generation,verified_at FROM user_pool_accounts').get(), { generation: 18, verified_at: null });
        assert.equal((proxy.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get('user_pool_events') as { seq: number }).seq, 99);
      } else assert.throws(() => proxy.prepare('SELECT 1 FROM user_pool_settings').get(), /no such table/);
      assert.throws(() => proxy.prepare('UPDATE proxy_accounts SET enterprise_id=?').run(randomUUID()), /enterprise_ownership_immutable/);
      assert.throws(() => proxy.prepare(`INSERT INTO proxy_accounts(enterprise_id,identity,sso_user,created_at,updated_at) VALUES(?,?,?,?,?)`).run(randomUUID(), 'other', 'other', stamp, stamp), /FOREIGN KEY/);
    } finally { proxy.close(); }
  }));
}
test('full target shape rejects missing triggers, extra indexes, altered checks and incomplete marker', () => {
  for (const mutate of [
    "DROP TRIGGER proxy_accounts_enterprise_immutable",
    'CREATE INDEX rogue ON proxy_accounts(sso_user)',
    'DELETE FROM enterprise_schema',
    "PRAGMA writable_schema=ON; UPDATE sqlite_schema SET sql=replace(sql,'CHECK(singleton = 1)','CHECK(singleton > 0)') WHERE name='enterprise_profiles'; PRAGMA writable_schema=OFF",
  ]) {
    const db = new Database(':memory:');
    try { initEnterpriseSqlite(db, 'proxy', profile); db.unsafeMode(true); db.exec(mutate); assert.throws(() => validateEnterpriseSqlite(db, 'proxy'), /enterprise_/); }
    finally { db.close(); }
  }
});
test('preflight fails closed for paused/owner/holds/claims/OAuth/pending Login and case ambiguity', () => temporary(dir => {
  const mutations: [number, string][] = [
    [0, 'UPDATE user_pool_settings SET paused=0'], [0, 'UPDATE user_pool_settings SET owner_until=9999999999999'],
    [0, "UPDATE proxy_accounts SET copilot_oauth_attempt_id='unresolved'"],
    [0, `INSERT INTO proxy_identity_initializations VALUES('claim','id','${stamp}','${stamp}','${stamp}')`],
    [0, "UPDATE user_pool_accounts SET stage='oauth-wait'"],
    [2, "UPDATE login_tasks SET status='pending'"],
    [1, `INSERT INTO sso_users(sso_user,password_hash,salt,email,created_at,updated_at) VALUES('SYNTHETIC_SYNTH','hash','salt','mail','${stamp}','${stamp}')`],
  ];
  for (const [index, sql] of mutations) {
    const plan = manifest(dir);
    const service = plan.services[index] as SqliteService;
    const db = new Database(service.source!); try { db.exec(sql); } finally { db.close(); }
    service.backup!.sha256 = sha256(readFileSync(service.source!));
    assert.throws(() => preflightEnterpriseSqlite(service, profile), /sqlite_/);
  }
}));
test('source sidecars, WAL headers, source hash changes, unknown schema, and failed output are never accepted', () => temporary(dir => {
  const plan = manifest(dir), service = plan.services[0] as SqliteService;
  writeFileSync(service.source! + '-wal', 'synthetic');
  assert.throws(() => preflightEnterpriseSqlite(service, profile), /standalone/); rmSync(service.source! + '-wal');
  const original = readFileSync(service.source!); const wal = Buffer.from(original); wal[18] = 2; wal[19] = 2;
  writeFileSync(service.source!, wal); assert.throws(() => preflightEnterpriseSqlite(service, profile), /standalone/);
  writeFileSync(service.source!, original); service.backup!.sha256 = '0'.repeat(64);
  assert.throws(() => preflightEnterpriseSqlite(service, profile), /hash_mismatch/); service.backup!.sha256 = sha256(original);
  writeFileSync(service.target, 'unapproved-partial-output');
  assert.throws(() => applyEnterpriseSqlite(service, plan), /standalone|apply_failed/);
  assert.equal(readFileSync(service.target, 'utf8'), 'unapproved-partial-output');
  assert.deepEqual(readFileSync(service.source!), original);
}));
test('manifest rejects secrets, missing attestations, duplicate locations, wrong versions and multiple profiles', () => temporary(dir => {
  const plan = manifest(dir);
  for (const change of [
    { password: 'not-allowed' }, { attestations: { ...plan.attestations, writersStopped: false } }, { manifestVersion: 2 },
    { profile: { ...profile, id: 'default' } }, { profiles: [profile] },
    { services: [plan.services[0], plan.services[0], plan.services[2]] },
  ]) assert.throws(() => parseEnterpriseManifest({ ...plan, ...change }));
}));
test('admins validation is read-only, strict, and never returns hashes or usernames', () => temporary(dir => {
  const plan = manifest(dir), path = join(dir, 'admins.json');
  writeFileSync(path, JSON.stringify([{ username: 'synthetic-admin', password_hash: 'a'.repeat(128), salt: 'b'.repeat(32), role: 'admin', enabled: true }]));
  const bytes = readFileSync(path); plan.admins = { path, backup: { reference: 'admins-backup', sha256: sha256(bytes) } };
  assert.deepEqual(validateAdminsFile(plan), { checked: true, count: 1, unchanged: true });
  assert.deepEqual(readFileSync(path), bytes);
}));
test('protected preflight plan artifact is exclusive, contains bindings and is reusable by apply/verify', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'enterprise-plan-'));
  try {
    const original = manifest(dir);
    const path = join(dir, 'approved-plan.json');
    const result = await runEnterpriseCommand('preflight', original, { planOut: path });
    assert.equal(result.ready, false);
    assert.doesNotMatch(JSON.stringify(result), /sourceSha256|backup_reference|synthetic-secret/);
    const bytes = readFileSync(path);
    const approved = JSON.parse(bytes.toString()) as unknown;
    await assert.rejects(() => runEnterpriseCommand('preflight', original, { planOut: path }));
    assert.deepEqual(readFileSync(path), bytes);
    assert.equal((await runEnterpriseCommand('apply', approved)).ready, true);
    assert.equal((await runEnterpriseCommand('verify', approved)).ready, true);
    await assert.rejects(() => runEnterpriseCommand('verify', approved, { planOut: join(dir, 'not-allowed.json') }), /plan_out/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('explicit file init requires new locations and leaves legacy history untouched', () => temporary(dir => {
  const plan = manifest(dir, 'direct');
  for (const item of plan.services) {
    const service = item as SqliteService; delete service.source; delete service.backup;
    assert.equal(initEnterpriseSqliteFile(service, plan).state, 'initialized');
    assert.throws(() => initEnterpriseSqliteFile(service, plan), /output_exists/);
  }
}));
