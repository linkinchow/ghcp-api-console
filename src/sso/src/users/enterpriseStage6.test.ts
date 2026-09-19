import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { parseEnterpriseRegistryV3, resolveEnterpriseScope } from '@ghcp/shared';
import { initEnterpriseSqliteV3 } from '@ghcp/shared/enterpriseStorageV3';
import { initSsoRegistryFixture, SECOND_FIXTURE_ID } from '../db/enterpriseFixture.js';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.INTERNAL_API_TOKEN = 'stage6-synthetic-internal-token';
process.env.SSO_DEFAULT_USER_PASSWORD = 'stage6-synthetic-password';
const input = structuredClone(initSsoRegistryFixture(true));
input.profiles.find(profile => profile.id === SECOND_FIXTURE_ID)!.sso.sessionSecretRef = { env: 'STAGE6_DRAFT_SESSION_SECRET' };
const registry = parseEnterpriseRegistryV3(input);
// Reinitialize this test's own fixture before loading the runtime; never bypass its gate.
rmSync(process.env.DB_PATH!);
const initialized = new Database(process.env.DB_PATH!);
try { initEnterpriseSqliteV3(initialized, 'sso', registry); } finally { initialized.close(); }
writeFileSync(process.env.ENTERPRISE_REGISTRY_FILE!, JSON.stringify(registry));
const a = resolveEnterpriseScope(registry), b = resolveEnterpriseScope(registry, SECOND_FIXTURE_ID);
const { getDb, getValidatedEnterpriseRegistry } = await import('../db/connection.js');
const { buildApp } = await import('../server.js');
const repo = await import('../db/usersRepo.js');
const service = await import('./service.js');
const settings = await import('../db/runtimeSettingsRepo.js');
const { ExternalOperationUncertainError } = await import('./operationFence.js');
const { hashPassword } = await import('../auth/password.js');
const create = (name: string, scope = a) => repo.createUser({ ssoUser: name, ...hashPassword('synthetic-local-password'), email: `${name}@synthetic.invalid` }, scope);
const fence = (name: string) => (getDb().prepare('SELECT operation_fence FROM sso_users WHERE enterprise_id=? AND sso_user=?').get(a.enterpriseId, name) as { operation_fence: string | null }).operation_fence;
const scopedHeaders = (scope = a) => ({ 'x-internal-token': process.env.INTERNAL_API_TOKEN!, 'x-enterprise-id': scope.enterpriseId, 'x-enterprise-revision': String(scope.enterpriseRevision) });

// Synthetic material and loopback HTTP only; all provider fetches below are intercepted.
test('draft B session secrets do not prevent boot, healthy A sign-in or readiness', async () => {
  const directory = dirname(process.env.DB_PATH!);
  const certPath = join(directory, 'synthetic.crt'), keyPath = join(directory, 'synthetic.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=stage6.synthetic.invalid'], { stdio: 'ignore' });
  process.env.TEST_SSO_SIGNING_CERT = readFileSync(certPath, 'utf8');
  process.env.TEST_SSO_SIGNING_KEY = readFileSync(keyPath, 'utf8');
  const user = create('healthy-a');
  const nativeFetch = globalThis.fetch;
  let outboundCalls = 0;
  globalThis.fetch = async () => { outboundCalls++; throw new Error('provider access forbidden'); };
  try {
    for (const secret of [undefined, 'short']) {
      if (secret === undefined) delete process.env.STAGE6_DRAFT_SESSION_SECRET;
      else process.env.STAGE6_DRAFT_SESSION_SECRET = secret;
      const app = buildApp(); // No eager session-secret read for the unusable draft.
      const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        assert.equal((await nativeFetch(`${base}/healthz`)).status, 200);
        for (const scope of [a, b]) {
          const response = await nativeFetch(`${base}/internal/profiles/${scope.enterpriseId}/readiness`, { headers: scopedHeaders(scope) });
          assert.equal(response.status, 200);
          const body = await response.json();
          assert.equal(body.ready, scope === a);
          assert.deepEqual(body.blockers, scope === a ? [] : ['saml_session_secret_unavailable']);
        }
        const page = await nativeFetch(`${base}/profiles/${a.enterpriseId}/login`);
        assert.equal(page.status, 200);
        const html = await page.text();
        const cookie = page.headers.getSetCookie()[0]!.split(';')[0]!;
        const tx = /name="tx" value="([^"]+)"/.exec(html)![1]!;
        const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
        const login = await nativeFetch(`${base}/profiles/${a.enterpriseId}/login`, {
          method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ tx, csrf, username: user.ssoUser, password: 'synthetic-local-password' }),
        });
        assert.equal(login.status, 200); assert.match(await login.text(), /Logged in as healthy-a/);
        const rejected = await nativeFetch(`${base}/profiles/${b.enterpriseId}/login`, { headers: { cookie } });
        assert.equal(rejected.status, 400); assert.deepEqual(rejected.headers.getSetCookie(), []);
        assert.doesNotMatch(await rejected.text(), /<form|short|SESSION_SECRET/);
      } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    }
    assert.equal(outboundCalls, 0);
  } finally { globalThis.fetch = nativeFetch; }
});

test('live scoped capacity is read-only and independent from full-enterprise readiness', async () => {
  process.env.STAGE6_DRAFT_SESSION_SECRET = 'stage6-draft-secret-now-explicitly-valid';
  settings.updateSsoRuntimeSettings({ expectedVersion: settings.getSsoRuntimeSettings(a).version, changes: { maxSsoUsers: repo.countUsers(a) } }, a);
  const app = buildApp(); const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const nativeFetch = globalThis.fetch; let outboundCalls = 0;
  globalThis.fetch = async () => { outboundCalls++; throw new Error('provider access forbidden'); };
  const capacity = (scope = a, headers: Record<string, string> = scopedHeaders(scope), suffix = '') => nativeFetch(`${base}/internal/profiles/${scope.enterpriseId}/creation-capacity${suffix}`, { headers });
  try {
    const db = getDb(), before = db.serialize();
    assert.equal((await capacity(a, {})).status, 401);
    assert.equal((await capacity(a, { 'x-internal-token': process.env.INTERNAL_API_TOKEN! })).status, 400);
    assert.equal((await capacity(a, scopedHeaders(b))).status, 400);
    assert.equal((await capacity(a, { ...scopedHeaders(a), 'x-enterprise-revision': '01' })).status, 400);
    assert.equal((await capacity(a, scopedHeaders(a), '?enterpriseId=' + b.enterpriseId)).status, 400);
    assert.equal((await nativeFetch(`${base}/internal/profiles/${randomUUID()}/creation-capacity`, { headers: scopedHeaders(a) })).status, 404);
    const full = await capacity(); assert.equal(full.status, 200); assert.equal(full.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await full.json(), { enterpriseId: a.enterpriseId, enterpriseRevision: 1, currentUsers: 1, maxUsers: 1, availableSlots: 0, canCreate: false });
    assert.deepEqual(await (await capacity(b)).json(), { enterpriseId: b.enterpriseId, enterpriseRevision: 1, currentUsers: 0, maxUsers: null, availableSlots: null, canCreate: true });
    const ready = await nativeFetch(`${base}/internal/profiles/${a.enterpriseId}/readiness`, { headers: scopedHeaders() });
    assert.equal((await ready.json()).ready, true);
    assert.deepEqual(db.serialize(), before); assert.equal(outboundCalls, 0);
    // Advisory capacity cannot replace the atomic write limit, including stale clients.
    const rejected = await nativeFetch(`${base}/api/profiles/${a.enterpriseId}/users`, { method: 'POST', headers: { ...scopedHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ ssoUser: 'over-capacity' }) });
    assert.equal(rejected.status, 409); assert.equal((await rejected.json()).error.code, 'sso_user_limit_reached');
    assert.equal(repo.countUsers(a), 1); assert.equal(repo.countUsers(b), 0);
    const current = settings.getSsoRuntimeSettings(a);
    settings.updateSsoRuntimeSettings({ expectedVersion: current.version, changes: { maxSsoUsers: 3 } }, a);
    assert.equal((await (await capacity()).json()).availableSlots, 2);
    settings.updateSsoRuntimeSettings({ expectedVersion: current.version + 1, changes: { maxSsoUsers: null, scimRequestDelayMs: 0, scimMaxRetries: 0 } }, a);
    assert.equal((await (await capacity()).json()).maxUsers, null);
  } finally { globalThis.fetch = nativeFetch; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('successful but invalid SCIM POST/PUT JSON preserves the durable fence with no repeated mutation', async () => {
  const invalid = [null, [], 'unexpected', {}, { userName: 'present' }, { id: 'present' }, { id: 'id', userName: null }, { id: 1, userName: 'name' }, { id: 'id', userName: 'name', githubLogin: null }];
  const nativeFetch = globalThis.fetch;
  try {
    for (const method of ['POST', 'PUT']) {
      for (const [index, value] of invalid.entries()) {
        const name = `invalid-${method}-${index}`, user = create(name);
        if (method === 'PUT') repo.updateEmu(name, { emuStatus: 'active', ghScimId: 'old-scim', ghLogin: 'old-login' }, user.userIncarnation, a);
        const before = repo.getUser(name, a); let calls = 0;
        globalThis.fetch = async (_url, init) => { calls++; assert.equal(init?.method, method); return Response.json(value, { status: method === 'POST' ? 201 : 200 }); };
        const operation = () => service.syncSsoUser(name, undefined, false, false, a);
        await assert.rejects(operation(), ExternalOperationUncertainError);
        const persisted = fence(name); assert.ok(persisted); assert.deepEqual(repo.getUser(name, a), before);
        getDb().close(); getDb(); assert.equal(fence(name), persisted);
        await assert.rejects(operation(), /in progress/);
        assert.throws(() => service.patchSsoUser(name, { role: 'admin' }, a), /in progress/);
        assert.throws(() => repo.deleteUser(name, user.userIncarnation, undefined, a), /in progress/);
        assert.equal(calls, 1); assert.equal(repo.getUser(name, b), undefined);
      }
    }
  } finally { globalThis.fetch = nativeFetch; }
});

test('malformed successful Proxy DELETE acknowledgments preserve fence and prevent repeat deletion', async () => {
  const nativeFetch = globalThis.fetch;
  const envelope = { enterpriseId: a.enterpriseId, enterpriseRevision: 1, contractVersion: 2, matchedAccounts: 1, deletedAccounts: 1, deletedRequestStats: 0 };
  const invalid = [null, [], 'unexpected', {}, { ...envelope, deletedAccounts: undefined }, { ...envelope, ssoUser: 'wrong' }, { ...envelope, deletedAccounts: -1 }, { ...envelope, deletedAccounts: 2 }, { ...envelope, deletedRequestStats: null }, { ...envelope, enterpriseId: b.enterpriseId }];
  try {
    for (const [index, value] of invalid.entries()) {
      const name = `invalid-delete-${index}`, user = create(name); let mutations = 0;
      globalThis.fetch = async (url, init) => {
        if (String(url).endsWith('/pool-membership')) return Response.json({ enterpriseId: a.enterpriseId, enterpriseRevision: 1, contractVersion: 2, managed: false });
        if ((init?.method ?? 'GET') === 'GET') return Response.json({ Resources: [] });
        mutations++; assert.equal(init?.method, 'DELETE');
        return Response.json(value && typeof value === 'object' && !Array.isArray(value) ? { ssoUser: name, ...value } : value);
      };
      await assert.rejects(service.deleteSsoUser(name, a), ExternalOperationUncertainError);
      assert.equal(repo.getUser(name, a)?.userIncarnation, user.userIncarnation);
      const persisted = fence(name); assert.ok(persisted); getDb().close(); getDb(); assert.equal(fence(name), persisted);
      await assert.rejects(service.deleteSsoUser(name, a), /in progress/);
      assert.equal(mutations, 1);
    }
  } finally { globalThis.fetch = nativeFetch; }
});

test('read failures and definite mutation rejections do not become uncertain fences', async () => {
  const nativeFetch = globalThis.fetch;
  try {
    const user = create('definite-create'); let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({}, { status: 409 }); };
    await assert.rejects(service.syncSsoUser(user.ssoUser, undefined, false, true, a), /create-only conflict/);
    assert.equal(fence(user.ssoUser), null); assert.equal(calls, 1);
    // A rejected create followed by invalid read JSON is not an unconfirmed mutation.
    globalThis.fetch = async (_url, init) => init?.method === 'POST' ? Response.json({}, { status: 409 }) : Response.json(null);
    await assert.rejects(service.syncSsoUser(user.ssoUser, undefined, false, false, a), error => !(error instanceof ExternalOperationUncertainError));
    assert.equal(fence(user.ssoUser), null);
    globalThis.fetch = async () => Response.json({ id: 'confirmed', userName: user.ssoUser });
    await service.syncSsoUser(user.ssoUser, undefined, false, true, a); assert.equal(fence(user.ssoUser), null);
    const deletion = create('definite-delete');
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/pool-membership')) return Response.json({ enterpriseId: a.enterpriseId, enterpriseRevision: 1, contractVersion: 2, managed: false });
      return init?.method === 'DELETE' ? Response.json({}, { status: 403 }) : Response.json({ Resources: [] });
    };
    await assert.rejects(service.deleteSsoUser(deletion.ssoUser, a), error => !(error instanceof ExternalOperationUncertainError));
    assert.equal(fence(deletion.ssoUser), null);
    globalThis.fetch = async () => Response.json(null);
    await assert.rejects(service.deleteSsoUser(deletion.ssoUser, a), /pool_membership_unavailable/);
    assert.equal(fence(deletion.ssoUser), null);
  } finally { globalThis.fetch = nativeFetch; }
});

test('recurring readiness uses bounded metadata queries, catches drift, and never reopens storage', () => {
  const db = getDb(); const queries: string[] = [];
  const prepare = db.prepare.bind(db), pragma = db.pragma.bind(db);
  db.prepare = ((sql: string) => { queries.push(sql); return prepare(sql); }) as typeof db.prepare;
  db.pragma = ((sql: string, options?: unknown) => { queries.push(`PRAGMA ${sql}`); return pragma(sql, options as never); }) as typeof db.pragma;
  try { for (let i = 0; i < 5; i++) assert.equal(getValidatedEnterpriseRegistry().registryRevision, 1); }
  finally { db.prepare = prepare; db.pragma = pragma; }
  assert.ok(queries.length > 0);
  for (const query of queries) assert.match(query, /^(PRAGMA (foreign_keys|schema_version)|SELECT \* FROM enterprise_(registry LIMIT 2|schema LIMIT 2|profiles ORDER BY id LIMIT 101))$/);
  db.pragma('foreign_keys = OFF'); assert.throws(getValidatedEnterpriseRegistry, /runtime_storage_changed/); db.pragma('foreign_keys = ON');
  assert.throws(() => db.transaction(() => { db.prepare('UPDATE enterprise_schema SET migration_id = ?').run('changed'); assert.throws(getValidatedEnterpriseRegistry, /runtime_storage_changed/); throw new Error('rollback-marker'); })(), /rollback-marker/);
  assert.throws(() => db.transaction(() => { db.prepare('UPDATE enterprise_profiles SET max_accounts = max_accounts + 1 WHERE id=?').run(a.enterpriseId); assert.throws(getValidatedEnterpriseRegistry, /runtime_storage_changed/); throw new Error('rollback-profile'); })(), /rollback-profile/);
  assert.throws(() => db.transaction(() => { db.prepare('UPDATE enterprise_registry SET registry_revision = registry_revision + 1, registry_sha256 = ?').run('f'.repeat(64)); assert.throws(getValidatedEnterpriseRegistry, /runtime_storage_changed/); throw new Error('rollback-registry'); })(), /rollback-registry/);
  assert.throws(() => db.transaction(() => { db.exec('CREATE TABLE unexpected_runtime_ddl(value TEXT)'); assert.throws(getValidatedEnterpriseRegistry, /runtime_storage_changed/); throw new Error('rollback-ddl'); })(), /rollback-ddl/);
  getValidatedEnterpriseRegistry();
  db.close(); assert.throws(getValidatedEnterpriseRegistry, /storage_not_ready/); assert.equal(db.open, false);
  assert.notEqual(getDb(), db); getValidatedEnterpriseRegistry();
});
