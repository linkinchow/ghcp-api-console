import assert from 'node:assert/strict';
import test from 'node:test';
import { enterprisePath, githubHost, listEnterprises, updatePoolPolicy } from './enterprises.js';
import { getLoginRuntimeSettings, loginPath } from './login.js';
import { proxyPath } from './proxy.js';
import { getSsoRuntimeSettings, ssoPath } from './sso.js';
import { getEnterprisePoolSummary, getUserPoolOverview, updateUserPoolSettings } from './userPool.js';

test('enterprisePath builds one scoped prefix per service', () => {
  assert.equal(enterprisePath('proxy', 'default'), '/api/console/proxy/enterprises/default');
  assert.equal(enterprisePath('sso', 'ghe-tenant'), '/api/console/sso/enterprises/ghe-tenant');
  assert.equal(enterprisePath('login-service', 'a1'), '/api/console/login-service/enterprises/a1');
  assert.equal(proxyPath('default'), enterprisePath('proxy', 'default'));
  assert.equal(ssoPath('default'), enterprisePath('sso', 'default'));
  assert.equal(loginPath('default'), enterprisePath('login-service', 'default'));
});

test('enterprisePath rejects missing, malformed and traversal ids instead of falling back', () => {
  for (const id of ['', 'Default', '1abc', 'a', 'a/b', '../default', 'default%2f', 'x'.repeat(33), 'trailing-']) {
    assert.throws(() => enterprisePath('proxy', id), /Invalid enterprise/, id);
  }
});

test('enterprise list, policy and scoped reads use explicit paths', async (t) => {
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  t.mock.method(globalThis, 'fetch', async (path: string | URL | Request, options?: RequestInit) => {
    const body = typeof options?.body === 'string' ? JSON.parse(options.body) : undefined;
    requests.push({ path: String(path), method: options?.method ?? 'GET', body });
    return new Response(JSON.stringify({ items: [], nameCapacity: 10000 }));
  });
  await listEnterprises();
  await updatePoolPolicy('ghe-tenant', { expectedVersion: 3, maxAccounts: 9 });
  await getSsoRuntimeSettings('ghe-tenant');
  await getLoginRuntimeSettings();
  await getUserPoolOverview();
  await getEnterprisePoolSummary('ghe-tenant');
  await updateUserPoolSettings(2, { idle_target: 4 });
  assert.deepEqual(requests, [
    { path: '/api/console/proxy/enterprises', method: 'GET', body: undefined },
    {
      path: '/api/console/proxy/enterprises/ghe-tenant/pool-policy',
      method: 'PATCH',
      body: { expectedVersion: 3, maxAccounts: 9 },
    },
    { path: '/api/console/sso/enterprises/ghe-tenant/settings/runtime', method: 'GET', body: undefined },
    { path: '/api/console/login-service/settings/runtime', method: 'GET', body: undefined },
    { path: '/api/console/proxy/user-pool/overview', method: 'GET', body: undefined },
    { path: '/api/console/proxy/enterprises/ghe-tenant/user-pool/summary', method: 'GET', body: undefined },
    {
      path: '/api/console/proxy/user-pool/settings',
      method: 'PATCH',
      body: { expectedVersion: 2, changes: { idle_target: 4 } },
    },
  ]);
});

test('githubHost shows the GitHub instance of an enterprise', () => {
  assert.equal(githubHost('https://octo.ghe.com'), 'octo.ghe.com');
  assert.equal(githubHost('https://example.test/'), 'example.test');
  assert.equal(githubHost('not a url'), 'not a url');
});
