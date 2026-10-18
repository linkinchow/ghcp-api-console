import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_ENTERPRISE_ID, defaultApiBaseUrls } from '@ghcp/shared';

// Direct mode (design §5.1): an account row decides its enterprise; new identities and the deprecated
// `/api/accounts` listing use DIRECT_MODE_ENTERPRISE_ID, here the GHE.com enterprise.
const SSO = 'http://sso.direct.test';
const LOGIN = 'http://login.direct.test';
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: join(tmpdir(), `missing-direct-enterprise-${randomUUID()}`),
  STORAGE_DRIVER: 'sqlite', DB_PATH: ':memory:', ACCOUNT_ROUTING_MODE: 'direct',
  DIRECT_MODE_ENTERPRISE_ID: 'contoso-eu',
  API_KEY: 'direct-key', INTERNAL_API_TOKEN: 'direct-internal', SSO_BASE_URL: SSO, LOGIN_BASE_URL: LOGIN,
  PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false',
});
const fixture = await import('../testing/enterpriseFixture.js');
const installed = fixture.installEnterpriseFixture();
const { buildApp } = await import('../server.js');
const { closeStorage } = await import('../db/connection.js');
const repo = await import('../db/accountsRepo.js');
const { listRequestStats } = await import('../db/requestStatsRepo.js');

const GHE = fixture.GHE_ENTERPRISE_ID;
const GITHUB_COPILOT = defaultApiBaseUrls({ baseUrl: '', isGheCom: false }).copilotApi;
const MODEL = 'claude-test-5.2';
const ENDPOINTS = ['/v1/messages'];
const INTERNAL = { 'X-Internal-Token': 'direct-internal', 'Content-Type': 'application/json' };

/** Every call to a mocked service as `METHOD origin+path`, with JSON bodies kept for assertions. */
const calls: Array<{ call: string; body?: Record<string, unknown> }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === '127.0.0.1') return originalFetch(input, init);
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
  calls.push({ call: `${init?.method ?? 'GET'} ${url.origin}${url.pathname}`, body });
  return reply(url, body);
};

function reply(url: URL, body?: Record<string, unknown>): Response {
  if (url.pathname === '/models') return Response.json({ data: [{ id: MODEL, supported_endpoints: ENDPOINTS }] });
  if (url.pathname === '/v1/messages') {
    return Response.json({ id: 'msg', type: 'message', role: 'assistant', model: MODEL, content: [] });
  }
  if (url.pathname.endsWith('/users/ensure')) {
    const user = ssoUser(String(body?.preferredSsoUser));
    return Response.json({ user, created: true, passwordForLogin: 'initial-password' });
  }
  if (url.pathname.endsWith('/users/batch')) {
    const user = { ...ssoUser(String((body?.ssoUsers as string[])[0])), ghLogin: 'new-user' };
    return Response.json({ rows: [{ ssoUser: user.ssoUser, status: 'success', user }] });
  }
  if (url.pathname.endsWith('/tasks')) {
    const createdAt = new Date().toISOString();
    return Response.json({ ...body, id: 'task-1', status: 'pending', attempts: 0, createdAt });
  }
  if (url.pathname.includes('/users/')) return Response.json({ ...ssoUser('imported'), ghLogin: 'imported-gh' });
  return new Response('unexpected', { status: 599 });
}

function ssoUser(name: string) {
  const at = new Date().toISOString();
  return { ssoUser: name, email: `${name}@contoso.test`, role: 'user', emuStatus: 'active',
    copilotSeatStatus: 'assigned', createdAt: at, updatedAt: at };
}

const server = buildApp().listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.after(async () => {
  globalThis.fetch = originalFetch;
  server.closeAllConnections();
  server.close();
  await closeStorage();
  installed.restore();
});

async function message(identity: string): Promise<{ status: number; body: any }> {
  const response = await originalFetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer direct-key', 'X-User-Identity': identity, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-test-5-2', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
  });
  return { status: response.status, body: await response.json() };
}

interface ApiResult {
  status: number;
  body: any;
  headers: Headers;
}

async function api(method: string, path: string, body?: unknown): Promise<ApiResult> {
  const response = await originalFetch(`${base}${path}`, {
    method, headers: INTERNAL, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100 && !await predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(await predicate());
}

test('an existing direct account is served by its own enterprise and its statistics stay there', async () => {
  for (const [enterpriseId, identity] of [[DEFAULT_ENTERPRISE_ID, 'octo-direct'], [GHE, 'ghe-direct']] as const) {
    await repo.importCopilotOauthToken({
      enterpriseId, identity, ssoUser: identity, ghLogin: identity, copilotOauthToken: `${identity}-token`,
    });
  }
  calls.length = 0;
  assert.equal((await message('octo-direct')).status, 200);
  assert.equal((await message('ghe-direct')).status, 200);
  const upstream = calls.map(({ call }) => call);
  assert.deepEqual(upstream, [
    `GET ${GITHUB_COPILOT}/models`, `POST ${GITHUB_COPILOT}/v1/messages`,
    `GET ${fixture.GHE_ENDPOINTS.copilotApiBaseUrl}/models`,
    `POST ${fixture.GHE_ENDPOINTS.copilotApiBaseUrl}/v1/messages`,
  ]);
  assert.equal((await listRequestStats(DEFAULT_ENTERPRISE_ID, 'octo-direct')).length, 1);
  assert.equal((await listRequestStats(GHE, 'ghe-direct')).length, 1);
  assert.equal((await listRequestStats(GHE, 'octo-direct')).length, 0);
});

test('a new direct identity is initialized in DIRECT_MODE_ENTERPRISE_ID through scoped SSO and Login', async () => {
  calls.length = 0;
  const started = await message('new-user@example.test');
  assert.equal(started.status, 202);
  await waitFor(async () => (await repo.getAccount('new-user@example.test'))?.copilotOauthStatus === 'refreshing');
  assert.equal((await repo.getAccount('new-user@example.test'))?.enterpriseId, GHE);
  const services = calls.map(({ call }) => call);
  assert.deepEqual(services, [
    `POST ${SSO}/api/enterprises/${GHE}/users/ensure`,
    `POST ${SSO}/api/enterprises/${GHE}/users/batch`,
    `POST ${LOGIN}/api/enterprises/${GHE}/tasks`,
  ]);
  const task = calls[2]!.body!;
  const fields = ['ghLogin', 'identity', 'oauthAttemptId', 'ssoPassword', 'ssoType', 'ssoUser'];
  assert.deepEqual(Object.keys(task).sort(), fields, 'no SSO page or selector override is sent');
});

test('the deprecated accounts API lists the direct-mode enterprise and imports into it', async () => {
  const listing = await api('GET', '/api/accounts');
  assert.equal(listing.status, 200);
  assert.equal(listing.headers.get('deprecation'), 'true');
  const ids = listing.body.items.map((item: { identity: string }) => item.identity).sort();
  assert.deepEqual(ids, ['ghe-direct', 'new-user@example.test']);
  const octo = await api('GET', '/api/accounts/octo-direct');
  assert.equal(octo.body.enterpriseId, DEFAULT_ENTERPRISE_ID, 'single rows are found by global identity');

  calls.length = 0;
  const csvText = 'name,copilotOauthToken\nimported,imported-token\nocto-direct,other-token';
  const imported = await api('POST', '/api/accounts/copilot-oauth-token/import', { csvText });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.rows[0].status, 'success');
  assert.equal(imported.body.rows[1].status, 'failed', 'a row of another enterprise is never overwritten');
  assert.match(imported.body.rows[1].detail, /another enterprise/);
  assert.equal((await repo.getAccount('imported'))?.enterpriseId, GHE);
  assert.equal((await repo.getAccount('octo-direct'))?.copilotOauthToken, 'octo-direct-token');
  assert.deepEqual(calls.map(({ call }) => call), [
    `GET ${SSO}/api/enterprises/${GHE}/users/imported`,
    `GET ${fixture.GHE_ENDPOINTS.copilotApiBaseUrl}/models`,
  ]);
});

test('manual reauthorization sends ssoType only while the enterprise profile leaves the provider open', async () => {
  const fixed = fixture.SECOND_ENTERPRISE_ID;
  const accounts = [[DEFAULT_ENTERPRISE_ID, 'octo-reauth'], [fixed, 'fab-reauth']] as const;
  for (const [enterpriseId, identity] of accounts) {
    await repo.createAccount({ enterpriseId, identity, ssoUser: identity, ghLogin: identity });
  }
  const bodies: Record<string, unknown>[] = [];
  for (const [enterpriseId, identity] of accounts) {
    calls.length = 0;
    const path = `/api/enterprises/${enterpriseId}/accounts/${identity}/copilot-oauth/reauthorize`;
    const result = await api('POST', path, { ssoPassword: 'override-password', ssoType: 'custom' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const task = calls.find(({ call }) => call === `POST ${LOGIN}/api/enterprises/${enterpriseId}/tasks`);
    assert.ok(task?.body);
    bodies.push(task.body);
  }
  assert.equal(bodies[0]!.ssoType, 'custom', 'r4: the task chooses its provider');
  assert.equal(Object.hasOwn(bodies[1]!, 'ssoType'), false, 'Login applies the profile provider (azure)');
});
