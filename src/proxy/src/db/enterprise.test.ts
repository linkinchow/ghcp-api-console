import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { assertEnterpriseRequest, assertProxyEnterpriseConfig } from '../enterprise.js';
import { SqliteStorage } from './sqliteStorage.js';
import { runMigrations } from './migrations.js';
import { UserPoolStore } from '../userPool/store.js';
import { readPoolConfig } from '../userPool/config.js';
import { TEST_ENTERPRISE, fixtureRegistry, createSqliteStorageFixture, initSqliteFixture } from '../test/enterpriseFixtures.js';

const options = readPoolConfig({ ACCOUNT_ROUTING_MODE: 'caller-lease', POOL_ACCOUNT_EMAIL_DOMAIN: TEST_ENTERPRISE.accountDomain,
  POOL_WARMUP_MODEL: 'synthetic-model', READY_IDLE_TARGET: '2', POOL_MAX_ACCOUNTS: '10' });

test('runtime refuses missing, empty and legacy SQLite without creating schema or WAL sidecars', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'proxy-enterprise-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = join(dir, 'missing.sqlite');
  await assert.rejects(new SqliteStorage(missing, 2, fixtureRegistry()).initialize(), /enterprise_init_required/);
  assert.equal(existsSync(missing), false);
  for (const legacy of [false, true]) {
    const path = join(dir, legacy ? 'legacy.sqlite' : 'empty.sqlite');
    const db = new Database(path);
    if (legacy) runMigrations(db);
    db.close();
    const before = createHash('sha256').update(readFileSync(path)).digest('hex');
    const storage = new SqliteStorage(path, 2, fixtureRegistry());
    await assert.rejects(storage.initialize(), /enterprise_v4_partial_or_unknown_schema/);
    await assert.rejects(storage.ping(), /not been initialized/);
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), before);
    assert.equal(existsSync(path + '-wal'), false);
    assert.equal(existsSync(path + '-shm'), false);
  }
});

test('direct initialized layout is never expanded to pool and explicit ownership is returned', async t => {
  const storage = createSqliteStorageFixture();
  t.after(() => storage.close());
  await storage.initialize();
  const created = await storage.createAccount({ identity: 'synthetic', ssoUser: 'synthetic' });
  assert.equal(created.enterpriseId, TEST_ENTERPRISE.id);
  const expectedAccount = await storage.getCopilotOauthTokenImportFence('imported');
  const imported = await storage.importCopilotOauthToken({ identity: 'imported', ssoUser: 'imported', copilotOauthToken: 'synthetic-only', expectedAccount });
  assert.equal(imported.enterpriseId, TEST_ENTERPRISE.id);
  assert.throws(() => storage.userPool(options), /enterprise_pool_layout_required/);
  assert.equal((await storage.getAccount('synthetic'))?.enterpriseId, TEST_ENTERPRISE.id);
});

test('pool cap has one physical owner, CAS updates atomically, and credential fence remains independent', () => {
  const db = new Database(':memory:');
  try {
    initSqliteFixture(db, options);
    const store = new UserPoolStore(db, options, fixtureRegistry(options));
    const columns = db.prepare('PRAGMA table_info(user_pool_settings)').all() as { name: string }[];
    assert.equal(columns.some(row => row.name === 'max_accounts'), false);
    const row = store.reserve()!;
    assert.equal((db.prepare('SELECT enterprise_id FROM proxy_accounts WHERE identity=?').get(row.identity) as {enterprise_id:string}).enterprise_id,
      TEST_ENTERPRISE.id);
    const policy = store.enterprisePolicy(TEST_ENTERPRISE.id)!;
    const next = store.updateEnterprisePolicy(TEST_ENTERPRISE.id, policy.policyVersion, { type: 'cap', maxAccounts: 5 });
    assert.equal(next.policyVersion, policy.policyVersion + 1);
    assert.equal(next.maxAccounts, 5);
    assert.equal((db.prepare('SELECT max_accounts FROM enterprise_profiles').get() as { max_accounts: number }).max_accounts, 5);
    assert.throws(() => store.updateSettings(1, { max_accounts: 3 }), /invalid_pool_settings/);
    assert.throws(() => store.updateEnterprisePolicy(TEST_ENTERPRISE.id, policy.policyVersion, { type: 'cap', maxAccounts: 3 }), /policy_version_conflict/);
    assert.equal(store.settings().max_accounts, 5);
    assert.throws(() => db.prepare('UPDATE proxy_accounts SET enterprise_id=? WHERE identity=?').run('wrong', row.identity), /binding_immutable/);
    assert.equal(store.inventory(row.identity)!.generation, row.generation);
    db.prepare("UPDATE proxy_accounts SET copilot_oauth_token='synthetic',copilot_oauth_status='valid' WHERE identity=?").run(row.identity);
    assert.equal(store.inventory(row.identity)!.generation, row.generation + 1);
    assert.equal(store.inventory(row.identity)!.verified_at, null);
    const reopened = new UserPoolStore(db, { ...options, maxAccounts: 100 }, fixtureRegistry(options));
    assert.equal(reopened.settings().max_accounts, 5);
  } finally { db.close(); }
});

test('instantiated service routes must match the trusted profile independently of environment', () => {
  const service = { enterpriseShortcode: TEST_ENTERPRISE.shortcode, ssoBaseUrl: TEST_ENTERPRISE.routes.ssoInternalUrl,
    loginBaseUrl: TEST_ENTERPRISE.routes.loginInternalUrl };
  assert.doesNotThrow(() => assertProxyEnterpriseConfig(TEST_ENTERPRISE, service));
  assert.throws(() => assertProxyEnterpriseConfig(TEST_ENTERPRISE, { ...service, ssoBaseUrl: 'http://other.invalid' }), /enterprise_config_mismatch/);
  assert.throws(() => assertProxyEnterpriseConfig(TEST_ENTERPRISE, { ...service, enterpriseShortcode: 'other' }), /enterprise_config_mismatch/);
});

test('request enterprise fields reject mismatch independently and retain legacy omission', () => {
  const request = (body: unknown, query = {}, headers = {}) => ({ body, query, headers });
  assert.doesNotThrow(() => assertEnterpriseRequest(request({ oauthAttemptId: 'old-nonce' }), TEST_ENTERPRISE));
  assert.doesNotThrow(() => assertEnterpriseRequest(request({ enterpriseId: TEST_ENTERPRISE.id, enterpriseRevision: 1 }), TEST_ENTERPRISE));
  assert.throws(() => assertEnterpriseRequest(request({ enterpriseId: 'default' }), TEST_ENTERPRISE), /unsupported_enterprise/);
  assert.throws(() => assertEnterpriseRequest(request({ enterpriseId: TEST_ENTERPRISE.id, enterpriseRevision: 2 }), TEST_ENTERPRISE), /revision_mismatch/);
  assert.throws(() => assertEnterpriseRequest(request({ enterpriseId: 'wrong' }, {}, { 'x-enterprise-id': TEST_ENTERPRISE.id }), TEST_ENTERPRISE), /unsupported_enterprise/);
  assert.throws(() => assertEnterpriseRequest(request({ enterpriseRevision: null }), TEST_ENTERPRISE), /revision_mismatch/);
});
