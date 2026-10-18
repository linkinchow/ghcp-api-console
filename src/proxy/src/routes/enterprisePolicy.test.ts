import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_ENTERPRISE_ID, DEFAULT_GITHUB_BASE_URL, type EnterpriseId } from '@ghcp/shared';

// Pool policy and enterprise-scoped pool administration (design §5.2, §5.8, §9.2).
const SSO = 'http://sso.policy.test';
const LOGIN = 'http://login.policy.test';
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: join(tmpdir(), `missing-enterprise-policy-${randomUUID()}`),
  STORAGE_DRIVER: 'sqlite', DB_PATH: ':memory:', ACCOUNT_ROUTING_MODE: 'caller-lease',
  POOL_ACCOUNT_EMAIL_DOMAIN: 'pool.default.test', POOL_WARMUP_MODEL: 'synthetic-model', READY_IDLE_TARGET: '5',
  POOL_MAX_ACCOUNTS: '10', API_KEY: 'policy-api-key', INTERNAL_API_TOKEN: 'policy-internal',
  SSO_BASE_URL: SSO, LOGIN_BASE_URL: LOGIN, PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false',
});
const fixture = await import('../testing/enterpriseFixture.js');
const installed = fixture.installEnterpriseFixture();
const { buildApp } = await import('../server.js');
const { getUserPool, stopUserPool } = await import('../userPool/runtime.js');
const { UserPoolStore } = await import('../userPool/store.js');
const { closeStorage } = await import('../db/connection.js');
const { enterpriseReadiness } = await import('../clients/enterpriseReadiness.js');
const { importCopilotOauthToken } = await import('../db/accountsRepo.js');

const GHE = fixture.GHE_ENTERPRISE_ID;
const HEADERS = { 'X-Internal-Token': 'policy-internal', 'Content-Type': 'application/json' };
const CALLER = `sha256:${'c'.repeat(64)}`;

/** Peer readiness rows; `notReady` names enterprises that SSO reports with a blocker. */
const notReady = new Set<string>();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === '127.0.0.1') return originalFetch(input, init);
  assert.equal(url.pathname, '/internal/enterprises', `unexpected call ${url.href}`);
  return Response.json(peerRows(url.origin === SSO));
};

function peerRows(sso: boolean) {
  const rows = [
    { id: 'default', githubBaseUrl: DEFAULT_GITHUB_BASE_URL, slug: 'acme', shortcode: 'octo' },
    { id: GHE, githubBaseUrl: fixture.GHE_ENDPOINTS.baseUrl, slug: 'contoso', shortcode: '' },
    { id: fixture.SECOND_ENTERPRISE_ID, githubBaseUrl: DEFAULT_GITHUB_BASE_URL, slug: 'fabrikam', shortcode: 'fab' },
  ];
  return rows.map((row) => {
    const blockers = sso && notReady.has(row.id) ? ['enterprise_secret_unconfigured:sso.scimToken'] : [];
    return { ...row, shortcode: sso ? row.shortcode : null, configured: blockers.length === 0, blockers };
  });
}

const server = buildApp().listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const pool = await getUserPool();
assert.ok(pool instanceof UserPoolStore);
const store = pool;

test.after(async () => {
  globalThis.fetch = originalFetch;
  server.closeAllConnections();
  server.close();
  await stopUserPool();
  await closeStorage();
  installed.restore();
});

interface CallResult {
  status: number;
  body: any;
  headers: Headers;
}

async function call(method: string, path: string, body?: unknown): Promise<CallResult> {
  const response = await originalFetch(`${base}${path}`, {
    method, headers: HEADERS, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function policyOf(id: string): Promise<{ policyVersion: number; state: string; maxAccounts: number }> {
  const list = await call('GET', '/api/enterprises');
  return list.body.items.find((item: { id: string }) => item.id === id).pool;
}

function patchPolicy(id: string, body: Record<string, unknown>) {
  enterpriseReadiness.clear();
  return call('PATCH', `/api/enterprises/${id}/pool-policy`, body);
}

async function readyMember(enterpriseId: EnterpriseId): Promise<string> {
  const member = store.reserve([enterpriseId]);
  assert.ok(member, `a member of ${enterpriseId} is reserved`);
  const { identity } = member;
  const token = `token-${identity}`;
  const credential = { enterpriseId, identity, ssoUser: identity, ghLogin: identity, copilotOauthToken: token };
  await importCopilotOauthToken(credential);
  store.update(identity, { state: 'ready', stage: 'ready', verified_at: store.now() });
  return identity;
}

test('the enterprise list joins registry, policy, readiness and pool summary', async () => {
  const list = await call('GET', '/api/enterprises');
  assert.equal(list.status, 200);
  const ids = list.body.items.map((item: { id: string }) => item.id);
  assert.deepEqual(ids, ['default', GHE, fixture.SECOND_ENTERPRISE_ID]);
  const [github, ghe] = list.body.items;
  assert.equal(github.pool.state, 'active');
  assert.equal(typeof github.shareScore, 'number');
  assert.equal(github.readiness.ready, true);
  assert.equal(ghe.pool.state, 'draft', 'enterprises added to the registry start as draft');
  assert.equal(ghe.shareScore, null);
  assert.equal(ghe.githubBaseUrl, fixture.GHE_ENDPOINTS.baseUrl);
  assert.equal(ghe.shortcode, '');
  assert.equal(ghe.poolSummary.total, 0);
  assert.equal(list.body.nameCapacity, 10000);
});

test('activation needs live readiness, and the policy is a CAS with fixed transitions', async () => {
  notReady.add(GHE);
  const draft = await policyOf(GHE);
  const blocked = await patchPolicy(GHE, { expectedVersion: draft.policyVersion, state: 'active' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'enterprise_not_ready');
  assert.deepEqual(blocked.body.error.details.blockers, ['sso:enterprise_secret_unconfigured:sso.scimToken']);
  assert.equal((await policyOf(GHE)).state, 'draft');

  notReady.delete(GHE);
  const active = await patchPolicy(GHE, { expectedVersion: draft.policyVersion, state: 'active' });
  assert.equal(active.status, 200, JSON.stringify(active.body));
  assert.equal(active.body.state, 'active');
  assert.equal(active.body.policyVersion, draft.policyVersion + 1);
  const stale = await patchPolicy(GHE, { expectedVersion: draft.policyVersion, maxAccounts: 5 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'policy_version_conflict');
  const back = await patchPolicy(GHE, { expectedVersion: active.body.policyVersion, state: 'draft' });
  assert.equal(back.body.error.code, 'invalid_state_transition');
  const tooMany = await patchPolicy(GHE, { expectedVersion: active.body.policyVersion, maxAccounts: 10000 });
  assert.equal(tooMany.body.error.code, 'name_capacity_exceeded');

  const draining = await patchPolicy(GHE, { expectedVersion: active.body.policyVersion, state: 'draining' });
  assert.equal(draining.body.state, 'draining');
  notReady.add(GHE);
  const resume = await patchPolicy(GHE, { expectedVersion: draining.body.policyVersion, state: 'active' });
  assert.equal(resume.body.error.code, 'enterprise_not_ready', 'resuming from draining is an activation');
  notReady.delete(GHE);
  const resumeBody = { expectedVersion: draining.body.policyVersion, state: 'active', maxAccounts: 6 };
  const resumed = await patchPolicy(GHE, resumeBody);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.maxAccounts, 6);
});

test('policy requests are validated and scoped by the path enterprise', async () => {
  for (const body of [{}, { expectedVersion: 1 }, { expectedVersion: 1, state: 'paused' },
    { expectedVersion: 1, maxAccounts: 0 }, { expectedVersion: 1, maxAccounts: 2, extra: true }]) {
    const result = await patchPolicy(GHE, body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(result.body.error.code, 'invalid_pool_policy');
  }
  const unknown = await patchPolicy('unknown-co', { expectedVersion: 1, maxAccounts: 2 });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'enterprise_not_found');
  const conflict = await patchPolicy(GHE, { expectedVersion: 1, maxAccounts: 2, enterpriseId: 'default' });
  assert.equal(conflict.status, 400);
  assert.equal(conflict.body.error.code, 'enterprise_scope_conflict');
});

test('pool lists, pages and actions never cross enterprises', async () => {
  const policy = await policyOf(GHE);
  if (policy.state !== 'active') await patchPolicy(GHE, { expectedVersion: policy.policyVersion, state: 'active' });
  const ghe = await readyMember(GHE);
  const github = await readyMember(DEFAULT_ENTERPRISE_ID);
  const listed = await call('GET', `/api/enterprises/${GHE}/user-pool/accounts`);
  assert.deepEqual(listed.body.items.map((item: { identity: string }) => item.identity), [ghe]);
  const page = await call('GET', `/api/enterprises/${GHE}/user-pool/page/accounts?q=${github}`);
  assert.equal(page.body.total, 0);
  const foreign = await call('POST', `/api/enterprises/${GHE}/user-pool/accounts/${github}/disable`);
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.error.code, 'member_not_found');
  assert.equal(store.inventory(github)?.state, 'ready');

  const held = store.acquire(CALLER);
  store.finish(held, true);
  const owner = held.enterprise_id;
  const other = owner === GHE ? DEFAULT_ENTERPRISE_ID : GHE;
  const release = (id: string) => call('POST', `/api/enterprises/${id}/user-pool/leases/${held.lease_id}/release`, {
    confirm: true,
  });
  assert.equal((await release(other)).status, 404, 'a lease of another enterprise is not found');
  assert.equal((await call('GET', `/api/enterprises/${other}/user-pool/leases`)).body.items.length, 0);
  assert.equal((await release(owner)).status, 200);
  const summary = await call('GET', `/api/enterprises/${GHE}/user-pool/summary`);
  assert.equal(summary.body.counts.total, 1);
});

test('unscoped pool, statistics and Models routes are refused; the legacy accounts API is deprecated', async () => {
  for (const path of ['/api/user-pool/accounts', '/api/user-pool/leases', '/api/request-stats', '/api/models',
    '/api/accounts/operations/x']) {
    const result = await call('GET', path);
    assert.equal(result.status, 400, path);
    assert.equal(result.body.error.code, 'enterprise_scope_required');
  }
  assert.equal((await call('GET', '/api/user-pool/overview')).status, 200);
  assert.equal((await call('GET', '/api/user-pool/settings')).status, 200);
  const member = await readyMember(GHE);
  const legacy = await call('GET', `/api/accounts/${member}`);
  assert.equal(legacy.status, 200);
  assert.equal(legacy.headers.get('deprecation'), 'true');
  assert.equal(legacy.body.enterpriseId, GHE);
  const listing = await call('GET', '/api/accounts');
  assert.equal(listing.headers.get('deprecation'), 'true');
  assert.ok(listing.body.items.every((item: { enterpriseId: string }) => item.enterpriseId === 'default'));
  assert.equal((await call('GET', `/api/enterprises/default/accounts/${member}`)).status, 404);
  assert.equal((await call('GET', `/api/enterprises/${GHE}/accounts/${member}`)).body.enterpriseId, GHE);
});
