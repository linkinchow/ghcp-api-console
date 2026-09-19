import assert from 'node:assert/strict';
import test, { after, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import Database from 'better-sqlite3';
import { INTERNAL_AUTH_HEADER, parseEnterpriseRegistryV3, type EnterpriseRegistryV3, type EnterpriseValidationEvidenceV1 } from '@ghcp/shared';
import { enterpriseProfileIdentityHashV4 } from '@ghcp/shared/enterpriseRuntimeV4';
import { enterpriseRegistryHashV3 } from '@ghcp/shared/enterpriseRuntimeV3';
import { initEnterpriseSqliteV4 } from '@ghcp/shared/enterpriseStorageV4';
import { UserPoolStore } from '../userPool/store.js';
import { readPoolConfig } from '../userPool/config.js';
import { accountName } from '../userPool/names.js';

// No deployed env, credential path or default dotenv is available to imported services.
const originalEnv = { ...process.env };
for (const key of Object.keys(process.env)) if (!/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMDRIVE|NODE_TEST_CONTEXT)$/i.test(key)) delete process.env[key];
Object.assign(process.env, { DOTENV_CONFIG_PATH: join(tmpdir(), `missing-management-${randomUUID()}.env`),
  STORAGE_DRIVER: 'sqlite', DB_PATH: ':memory:', MYSQL_SSL_MODE: 'disabled', ACCOUNT_ROUTING_MODE: 'direct',
  PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false', INTERNAL_API_TOKEN: 'synthetic-management-token' });
const [{ config }, { closeStorage }, { requireInternalToken }, { createEnterpriseManagementRouter },
  { createUserPoolApiRouter }, { adminApiRouter }, { EnterpriseReadinessError }, { SqliteStorage }] = await Promise.all([
  import('../config.js'), import('../db/connection.js'), import('../auth/internalAuth.js'), import('./enterpriseManagement.js'),
  import('./userPoolApi.js'), import('./adminApi.js'), import('../clients/enterpriseReadiness.js'), import('../db/sqliteStorage.js'),
]);
after(async () => {
  await closeStorage();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

const A = '10000000-0000-4000-8000-000000000001';
const B = '20000000-0000-4000-8000-000000000002';
const UNKNOWN = '30000000-0000-4000-8000-000000000003';
const TOKEN = 'synthetic-management-token';
const SECRET_MARKER = 'DO_NOT_SERIALIZE_SECRET_REFERENCE';
const caller = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;
function registry(): EnterpriseRegistryV3 {
  return parseEnterpriseRegistryV3({ version: 3, registryRevision: 7, legacyEnterpriseId: A,
    profiles: [A, B].map((id, i) => {
      const origin = `http://127.0.0.1:${7100 + 10 * i}`;
      const prefix = i === 0 ? '' : `/profiles/${id}`;
      return { id, slug: i === 0 ? 'legacy-synthetic' : 'new-synthetic', shortcode: i === 0 ? 'legacy' : 'newco',
        revision: i + 1, accountDomain: `pool${i}.example.test`, maxAccounts: i === 0 ? 600 : 400,
        routes: { proxyInternalUrl: 'http://127.0.0.1:3100', ssoInternalUrl: origin, loginInternalUrl: `http://127.0.0.1:${7101 + 10 * i}`, ssoPublicUrl: origin },
        sso: { entityId: `urn:management:${i}`, ssoUrl: `${origin}${prefix}/sso`, loginUrl: `${origin}${prefix}/login`, logoutUrl: `${origin}${prefix}/logout`,
          spEntityId: `urn:sp:${i}`, spAcsUrl: 'https://github.example.test/saml/consume', scimBaseUrl: 'https://github.example.test/scim',
          githubApiBaseUrl: 'https://github.example.test', emailDomain: 'example.test', userPrefix: `synthetic${i}`,
          signingCertRef: { env: SECRET_MARKER }, signingKeyRef: { env: 'SYNTHETIC_SECRET_KEY' }, sessionSecretRef: { env: 'SYNTHETIC_SESSION_SECRET' } },
        login: { provider: 'custom', allowedLoginUrls: [`${origin}${prefix}/login`], selectors: {} } };
    }) });
}
function readiness(value: EnterpriseRegistryV3, id: string, now: number): EnterpriseValidationEvidenceV1 {
  const profile = value.profiles.find(profile => profile.id === id)!;
  const identity = { enterpriseId: id, enterpriseRevision: profile.revision, profileIdentitySha256: enterpriseProfileIdentityHashV4(profile),
    registryRevision: value.registryRevision, registrySha256: enterpriseRegistryHashV3(value), legacyEnterpriseId: value.legacyEnterpriseId };
  const probe = { ...identity, probeVersion: 1 as const, schemaVersion: 3, contractVersion: 2 as const,
    capability: 'enterprise-isolation-legacy-pool', ready: true, blockers: [] };
  return { ...identity, version: 1, checkedAt: now, sso: { ...probe, component: 'sso' }, login: { ...probe, component: 'login' } };
}

async function fixture(t: TestContext, mode: 'pool' | 'direct' = 'pool') {
  await closeStorage();
  const savedConfig = { ...config };
  const value = registry();
  const dir = mkdtempSync(join(tmpdir(), 'enterprise-management-http-'));
  const path = join(dir, 'proxy.sqlite'), registryPath = join(dir, 'registry.json');
  writeFileSync(registryPath, JSON.stringify(value));
  process.env.ENTERPRISE_REGISTRY_FILE = registryPath;
  const options = readPoolConfig({ ACCOUNT_ROUTING_MODE: 'caller-lease', POOL_ACCOUNT_EMAIL_DOMAIN: value.profiles[0].accountDomain,
    POOL_WARMUP_MODEL: 'synthetic-model', READY_IDLE_TARGET: '0', POOL_MAX_ACCOUNTS: '1000' });
  const db = new Database(path); db.pragma('foreign_keys=ON');
  const disabledByMode = mode === 'direct';
  initEnterpriseSqliteV4(db, 'proxy', value, disabledByMode ? { layout: 'direct' } : { layout: 'pool', pool: { fingerprint: 'f'.repeat(64), settings: {
    version: 1, idle_target: 0, lease_seconds: 3600, paused: 1, next_ordinal: 0, account_domain: options.accountDomain, owner: null, owner_until: 0,
  } } });
  const directStorage = disabledByMode ? new SqliteStorage(path, 10000, value, db) : undefined;
  await directStorage?.initialize();
  // The pool branch alone constructs a pool store; direct mode never creates pool tables or policies online.
  const store = disabledByMode ? undefined : new UserPoolStore(db, options, value);
  Object.assign(config, { storageDriver: 'sqlite', dbPath: path, requestStatsPerAccountLimit: 10000, internalApiToken: TOKEN,
    ssoBaseUrl: value.profiles[0].routes.ssoInternalUrl, loginBaseUrl: value.profiles[0].routes.loginInternalUrl,
    enterpriseShortcode: value.profiles[0].shortcode, errorDiagnosticsEnabled: false });
  let wakes = 0;
  const probes: string[] = [];
  let probe: (id: string) => Promise<EnterpriseValidationEvidenceV1> = async id => readiness(value, id, store?.now() ?? Date.now());
  const app = express(); app.use(express.json());
  // Production's outer internal-token boundary is retained for adminApiRouter as well.
  app.use('/api', requireInternalToken, createEnterpriseManagementRouter({ registry: () => value,
    policies: async () => directStorage ? directStorage.enterprisePolicies() : store!.enterprisePolicies(), pool: async () => store,
    probe: async (_registry, id) => { probes.push(id); return probe(id); }, wake: () => { wakes++; } }),
  adminApiRouter, createUserPoolApiRouter({ getStore: async () => mode === 'pool' ? store : undefined,
    wake: () => { wakes++; }, isPoolEnabled: () => mode === 'pool', localScheduler: () => undefined }));
  app.use((_req, res) => { res.status(404).json({ error: { code: 'not_found' } }); });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server)); server.once('error', reject);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    assert.equal(target.origin, origin, 'test refuses all provider/non-fixture network destinations');
    return realFetch(input, init);
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    await closeStorage(); await directStorage?.close(); if (db.open) db.close(); Object.assign(config, savedConfig); rmSync(dir, { recursive: true, force: true });
  });
  const request = async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    assert.ok(path.startsWith('/api/'));
    const response = await fetch(origin + path, { method, headers: { [INTERNAL_AUTH_HEADER]: TOKEN, ...headers,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(5000) });
    const text = await response.text();
    let json: any; try { json = JSON.parse(text); } catch { assert.fail(`non-JSON status ${response.status}: ${text.slice(0, 200)}`); }
    return { status: response.status, body: json, text, headers: response.headers };
  };
  const enable = async (id: string) => {
    assert.ok(store, 'pool-only fixture operation');
    let policy = store.enterprisePolicy(id)!;
    const validated = await request(`/api/profiles/${id}/pool-policy/validate`, 'POST', { expectedVersion: policy.policyVersion });
    assert.equal(validated.status, 200, validated.text);
    const active = await request(`/api/profiles/${id}/pool-policy/activate`, 'POST', { expectedVersion: validated.body.policyVersion, confirm: true });
    assert.equal(active.status, 200, active.text);
    return active.body;
  };
  const member = (id: string, identity: string, state = 'ready') => {
    assert.ok(store, 'pool-only fixture operation');
    const now = store.now(), timestamp = new Date(now).toISOString();
    const ordinal = (db.prepare('SELECT next_ordinal n FROM user_pool_settings').get() as { n: number }).n;
    db.prepare(`INSERT INTO proxy_accounts(enterprise_id,account_incarnation,identity,sso_user,gh_login,copilot_oauth_status,copilot_oauth_token,created_at,updated_at)
      VALUES(?,?,?,?,?,'valid',?,?,?)`).run(id, randomUUID(), identity, identity, `${identity}-login`, `synthetic-private-token-${identity}`, timestamp, timestamp);
    db.prepare(`INSERT INTO user_pool_accounts(identity,ordinal,state,stage,attempt_id,updated_at,retry_at,verified_at)
      VALUES(?,?,?,'ready',?,?,?,?)`).run(identity, ordinal, state, randomUUID(), now, now, now);
    db.prepare('UPDATE user_pool_settings SET next_ordinal=next_ordinal+1').run();
    return store.inventory(identity)!;
  };
  return { request, value, db, get store(): UserPoolStore { assert.ok(store, 'pool-only fixture operation'); return store; }, enable, member, probes, wakes: () => wakes,
    setProbe(value: typeof probe) { probe = value; } };
}

function noSecrets(response: { text: string }) {
  for (const secret of [SECRET_MARKER, 'SYNTHETIC_SECRET_KEY', 'SYNTHETIC_SESSION_SECRET', 'synthetic-private-token',
    'signingCertRef', 'signingKeyRef', 'validationEvidence', 'profileIdentitySha256', 'scimBaseUrl', 'allowedLoginUrls']) {
    assert.equal(response.text.includes(secret), false, secret);
  }
}

test('authenticated loopback discovery is safe; fresh v4 profiles remain draft and paused', async t => {
  const f = await fixture(t);
  for (const path of ['/api/management/enterprises', '/api/management/pool/settings', `/api/profiles/${B}/pool-policy`, `/api/profiles/${B}/user-pool/summary`, '/api/accounts']) {
    const unauthorized = await f.request(path, 'GET', undefined, { [INTERNAL_AUTH_HEADER]: '' });
    assert.equal(unauthorized.status, 401); assert.equal(unauthorized.body.error.code, 'internal_auth_failed');
  }
  const list = await f.request('/api/management/enterprises'); assert.equal(list.status, 200); assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.equal(list.body.legacyEnterpriseId, A); assert.deepEqual(list.body.enterprises.map((row: any) => row.state), ['draft', 'draft']);
  noSecrets(list); assert.deepEqual(f.probes, []);
  const summary = await f.request('/api/management/pool/summary'); assert.equal(summary.body.settings.paused, 1);
  assert.equal(summary.body.settings.max_accounts, 1000); assert.equal(summary.body.settings.active_max_accounts, 0); noSecrets(summary);
  assert.equal((await f.request(`/api/profiles/${UNKNOWN}/pool-policy`)).status, 404);
  assert.equal((await f.request(`/api/profiles/${B}/pool-policy`, 'GET', undefined, { 'x-enterprise-id': A })).status, 400);
  assert.equal((await f.request(`/api/profiles/${B}/pool-policy`, 'GET', undefined, { 'x-enterprise-revision': '1' })).status, 409);
  assert.equal((await f.request('/api/management/enterprises?enterpriseId=' + B)).status, 400);
});

test('HTTP cap mutation uses policy CAS, strict min/sum limits; global max is immutable and target independent', async t => {
  const f = await fixture(t);
  const cap = await f.request(`/api/profiles/${B}/pool-policy`, 'PATCH', { expectedVersion: 1, maxAccounts: 450 });
  assert.equal(cap.status, 200); assert.equal(cap.body.maxAccounts, 450); assert.equal(cap.body.policyVersion, 2); assert.equal(cap.body.state, 'draft'); noSecrets(cap);
  const stale = await f.request(`/api/profiles/${B}/pool-policy`, 'PATCH', { expectedVersion: 1, maxAccounts: 451 }); assert.equal(stale.status, 409);
  for (const maxAccounts of [0, -1, 1.5, 10001, 9500]) {
    assert.equal((await f.request(`/api/profiles/${B}/pool-policy`, 'PATCH', { expectedVersion: 2, maxAccounts })).status, 400);
    assert.equal(f.store.enterprisePolicy(B)!.maxAccounts, 450);
  }
  for (const path of ['/api/management/pool/settings', '/api/user-pool/settings']) {
    assert.equal((await f.request(path, 'PATCH', { expectedVersion: 1, changes: { max_accounts: 1000 } })).status, 400);
  }
  const changed = await f.request('/api/management/pool/settings', 'PATCH', { expectedVersion: 1, changes: { idle_target: 10000 } });
  assert.equal(changed.status, 200); assert.equal(changed.body.idle_target, 10000); assert.equal(changed.body.max_accounts, 1050);
  assert.equal((await f.request('/api/management/pool/settings', 'PATCH', { expectedVersion: 1, changes: { paused: 0 } })).status, 409);
  assert.equal((await f.request('/api/management/pool/settings', 'PATCH', { expectedVersion: 2, changes: { idle_target: 10001 } })).status, 400);
  const active = await f.enable(A);
  const raceVersion = active.policyVersion;
  const results = await Promise.all([f.request(`/api/profiles/${A}/pool-policy`, 'PATCH', { expectedVersion: raceVersion, maxAccounts: 590 }),
    f.request(`/api/profiles/${A}/pool-policy`, 'PATCH', { expectedVersion: raceVersion, maxAccounts: 580 })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(f.store.enterprisePolicy(A)!.policyVersion, raceVersion + 1);
  assert.equal(f.wakes(), 5);
});

test('validation is not activation; explicit confirm/CAS controls lifecycle and legacy active leaves new profile draft', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(`/api/profiles/${A}/pool-policy/activate`, 'POST', { expectedVersion: 1, confirm: true })).status, 409);
  const validated = await f.request(`/api/profiles/${A}/pool-policy/validate`, 'POST', { expectedVersion: 1 });
  assert.equal(validated.status, 200); assert.equal(validated.body.state, 'validated'); assert.equal(f.store.settings().active_max_accounts, 0);
  assert.equal((await f.request(`/api/profiles/${A}/pool-policy/activate`, 'POST', { expectedVersion: 2, confirm: false })).status, 400);
  const active = await f.request(`/api/profiles/${A}/pool-policy/activate`, 'POST', { expectedVersion: 2, confirm: true });
  assert.equal(active.status, 200); assert.equal(active.body.state, 'active'); assert.equal(f.store.enterprisePolicy(B)!.state, 'draft');
  assert.equal(f.store.settings().active_max_accounts, 600);
  const draftMember = f.member(B, 'draft-member'); assert.equal(f.store.inventory(draftMember.identity)!.enterprise_id, B);
  assert.throws(() => f.store.acquire(caller(1)), /pool_exhausted/);
  const paused = await f.request(`/api/profiles/${A}/pool-policy/drain`, 'POST', { expectedVersion: 3, confirm: true });
  assert.equal(paused.status, 200); assert.equal(paused.body.state, 'draining');
  assert.equal((await f.request(`/api/profiles/${A}/pool-policy/activate`, 'POST', { expectedVersion: 4, confirm: true })).status, 409);
  noSecrets(active); noSecrets(paused);
});

test('readiness blockers are structured and safe; failures cannot validate or activate policy', async t => {
  const f = await fixture(t);
  f.setProbe(async () => { throw new EnterpriseReadinessError('enterprise_readiness_blocked', ['login_secret_unavailable', 'pool_provider_unsupported']); });
  const blocked = await f.request(`/api/profiles/${B}/pool-policy/validate`, 'POST', { expectedVersion: 1 });
  assert.equal(blocked.status, 503); assert.deepEqual(blocked.body.error.details.blockers, ['login_secret_unavailable', 'pool_provider_unsupported']);
  assert.equal(f.store.enterprisePolicy(B)!.state, 'draft'); assert.equal(f.store.enterprisePolicy(B)!.policyVersion, 1); noSecrets(blocked);
  f.setProbe(async () => { throw new Error(`private upstream ${SECRET_MARKER}`); });
  const unavailable = await f.request(`/api/profiles/${B}/pool-policy/validate`, 'POST', { expectedVersion: 1 });
  assert.equal(unavailable.status, 503); noSecrets(unavailable);
  f.setProbe(async id => { const e = readiness(f.value, id, f.store.now()); e.login.enterpriseId = A; return e; });
  const mismatch = await f.request(`/api/profiles/${B}/pool-policy/validate`, 'POST', { expectedVersion: 1 });
  assert.equal(mismatch.status, 400); assert.equal(f.store.enterprisePolicy(B)!.policyVersion, 1);
});

test('legacy roots remain pinned, scoped list/page/count/actions reject wrong enterprise and events retain ownership', async t => {
  const f = await fixture(t); await f.enable(A); await f.enable(B);
  const legacy = accountName(0), second = accountName(1);
  f.member(A, legacy); f.member(B, second);
  f.store.event('account_ready', legacy); f.store.event('account_ready', second); f.store.event('settings_updated');
  const root = await f.request('/api/user-pool'); assert.equal(root.status, 200); assert.equal(root.body.poolId, A);
  assert.deepEqual(root.body.accounts.map((row: any) => row.identity), [legacy]); noSecrets(root);
  const page = await f.request(`/api/profiles/${B}/user-pool/page/accounts?page=1&pageSize=1&q=${encodeURIComponent(second)}`);
  assert.equal(page.status, 200); assert.equal(page.body.total, 1); assert.equal(page.body.items[0].enterpriseId, B); noSecrets(page);
  const summary = await f.request(`/api/profiles/${B}/user-pool/summary`); assert.equal(summary.body.counts.total, 1); assert.deepEqual(summary.body.accounts, []);
  assert.equal((await f.request(`/api/profiles/${A}/user-pool/accounts/${second}/disable`, 'POST', {})).status, 404);
  assert.equal((await f.request(`/api/user-pool/accounts/${second}/disable`, 'POST', {})).status, 404);
  assert.equal((await f.request(`/api/profiles/${B}/user-pool/accounts/${second}/disable`, 'POST', {})).status, 200);
  assert.equal(f.store.inventory(second)!.state, 'disabled');
  assert.equal((await f.request(`/api/profiles/${A}/user-pool/accounts/${second}/resume`, 'POST', {})).status, 404);
  assert.equal((await f.request(`/api/profiles/${B}/user-pool/accounts/${second}/resume`, 'POST', {})).status, 200);
  assert.equal(f.store.inventory(second)!.state, 'provisioning');
  const accounts = await f.request('/api/accounts?page=1&pageSize=10'); assert.equal(accounts.status, 200); assert.equal(accounts.body.total, 1); assert.equal(accounts.body.items[0].enterpriseId, A);
  const scopedAccounts = await f.request(`/api/profiles/${B}/accounts?page=1&pageSize=10`); assert.equal(scopedAccounts.body.total, 1); assert.equal(scopedAccounts.body.items[0].enterpriseId, B);
  assert.equal((await f.request(`/api/profiles/${A}/accounts/${second}`)).status, 404);
  f.db.prepare('DELETE FROM user_pool_accounts WHERE identity=?').run(second); f.db.prepare('DELETE FROM proxy_accounts WHERE identity=?').run(second);
  const events = await f.request(`/api/profiles/${B}/user-pool/page/events?page=1&pageSize=100`); assert.equal(events.status, 200);
  assert.equal(events.body.total, 3); assert.equal(events.body.items.every((row: any) => row.enterpriseId === B), true);
  const legacyEvents = await f.request('/api/user-pool/page/events?page=1&pageSize=100'); assert.equal(legacyEvents.body.total, 1);
});

test('HTTP drain preserves existing leases; scoped release requires matching enterprise and explicit confirmation', async t => {
  const f = await fixture(t); await f.enable(A); f.member(A, 'leased-member');
  const held = f.store.acquire(caller(1)); f.store.finish(held, true);
  const policy = f.store.enterprisePolicy(A)!;
  const drained = await f.request(`/api/profiles/${A}/pool-policy/drain`, 'POST', { expectedVersion: policy.policyVersion, confirm: true });
  assert.equal(drained.status, 200); assert.equal(f.store.leases(A).length, 1);
  const existing = f.store.acquire(caller(1)); assert.equal(existing.lease_id, held.lease_id); f.store.finish(existing, false);
  assert.equal((await f.request(`/api/profiles/${B}/user-pool/leases/${held.lease_id}/release`, 'POST', { confirm: true })).status, 404);
  assert.equal((await f.request(`/api/profiles/${A}/user-pool/leases/${held.lease_id}/release`, 'POST', {})).status, 400);
  const released = await f.request(`/api/profiles/${A}/user-pool/leases/${held.lease_id}/release`, 'POST', { confirm: true });
  assert.equal(released.status, 200); assert.equal(f.store.leases(A).length, 0);
});

test('request-stat server pagination exceeds legacy 1000 cap, matches scoped totals and excludes historical unknown rows', async t => {
  const f = await fixture(t);
  const insert = f.db.prepare(`INSERT INTO proxy_request_stats(id,identity,requested_at,path,model,success,enterprise_id)
    VALUES(?,?,'2026-09-18T00:00:00.000Z','/responses',?,?,?)`);
  f.db.transaction(() => {
    for (let n = 0; n < 1205; n++) insert.run(`b-${String(n).padStart(6, '0')}`, n % 2 ? 'shared-identity' : 'other-identity', n % 2 ? 'model-odd' : 'model-even', n % 2, B);
    for (let n = 0; n < 7; n++) insert.run(`a-${n}`, 'shared-identity', 'model-odd', 1, A);
    insert.run('unknown', 'shared-identity', 'model-odd', 1, null);
  })();
  const late = await f.request(`/api/profiles/${B}/request-stats/page?page=13&pageSize=100`);
  assert.equal(late.status, 200, late.text); assert.equal(late.body.total, 1205); assert.equal(late.body.items.length, 5);
  assert.equal(late.body.items.every((row: any) => row.enterpriseId === B), true); assert.equal(late.headers.get('cache-control'), 'no-store');
  const filtered = await f.request(`/api/profiles/${B}/request-stats/page?page=2&pageSize=100&success=true&model=model-odd&identity=shared-identity`);
  assert.equal(filtered.status, 200); assert.equal(filtered.body.total, 602); assert.equal(filtered.body.items.length, 100);
  const wildcard = await f.request(`/api/profiles/${B}/request-stats/page?q=%25`); assert.equal(wildcard.body.total, 0);
  const legacy = await f.request('/api/request-stats?limit=2000'); assert.equal(legacy.status, 200); assert.equal(legacy.body.length, 7);
  assert.equal(legacy.body.every((row: any) => row.enterpriseId === A), true);
  for (const query of ['page=0', 'pageSize=101', 'success=1', `enterpriseId=${A}`, 'q=x&q=y']) {
    assert.equal((await f.request(`/api/profiles/${B}/request-stats/page?${query}`)).status, 400);
  }
  noSecrets(late); noSecrets(filtered);
});

test('management summary is logically read-only with expired lease/cooling rows', async t => {
  const f = await fixture(t); await f.enable(A); f.member(A, 'expired-member');
  const held = f.store.acquire(caller(1)); f.store.finish(held, true);
  f.db.prepare('UPDATE user_pool_leases SET expires_at=?').run(f.store.now() - 1);
  f.db.prepare("UPDATE user_pool_accounts SET state='cooling',cooldown_until=?").run(f.store.now() - 1);
  const before = f.db.serialize(); const result = await f.request('/api/management/pool/summary');
  assert.equal(result.status, 200); assert.equal(result.body.supply.eligibleIdle, 1); assert.deepEqual(f.db.serialize(), before);
});

test('direct-mode management discovery remains available without enabling the pool', async t => {
  const f = await fixture(t, 'direct');
  const discovery = await f.request('/api/management/enterprises'); assert.equal(discovery.status, 200); assert.equal(discovery.body.enabled, false);
  assert.deepEqual(discovery.body.enterprises.map((row: any) => row.state), ['draft', 'draft']);
  for (const path of ['/api/management/pool/settings', '/api/management/pool/summary', `/api/profiles/${A}/pool-policy`, `/api/profiles/${B}/user-pool/summary`]) {
    const disabled = await f.request(path); assert.equal(disabled.status, 409); assert.equal(disabled.body.error.code, 'pool_mode_disabled');
  }
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='user_pool_accounts'").get(), undefined);
  assert.deepEqual(f.probes, []); assert.equal(f.wakes(), 0);
});
