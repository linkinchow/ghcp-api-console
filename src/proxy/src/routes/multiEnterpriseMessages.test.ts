import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_ENTERPRISE_ID, defaultApiBaseUrls, type EnterpriseId } from '@ghcp/shared';

// Caller-lease inference uses the Copilot API of the leased member's enterprise (design §5.4, §9.2):
// one github.com enterprise and one GHE.com enterprise serve different callers through one Proxy.
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: join(tmpdir(), `missing-multi-messages-${randomUUID()}`),
  STORAGE_DRIVER: 'sqlite', DB_PATH: ':memory:', ACCOUNT_ROUTING_MODE: 'caller-lease',
  POOL_ACCOUNT_EMAIL_DOMAIN: 'pool.default.test', POOL_WARMUP_MODEL: 'claude-test-5-2', READY_IDLE_TARGET: '5',
  POOL_MAX_ACCOUNTS: '10', API_KEY: 'multi-messages-key', INTERNAL_API_TOKEN: 'multi-messages-internal',
  PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false',
});
const fixture = await import('../testing/enterpriseFixture.js');
const installed = fixture.installEnterpriseFixture();
const { buildApp } = await import('../server.js');
const { getUserPool, stopUserPool } = await import('../userPool/runtime.js');
const { UserPoolStore } = await import('../userPool/store.js');
const { closeStorage } = await import('../db/connection.js');
const { importCopilotOauthToken } = await import('../db/accountsRepo.js');
const { listRequestStats } = await import('../db/requestStatsRepo.js');

const GHE = fixture.GHE_ENTERPRISE_ID;
const GITHUB_COPILOT = defaultApiBaseUrls({ baseUrl: '', isGheCom: false }).copilotApi;
const MODEL = 'claude-test-5.2';
const ENDPOINTS = ['/v1/messages'];

/** Each upstream call as `<origin> <path> <token>`. */
const upstream: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === '127.0.0.1') return originalFetch(input, init);
  const token = new Headers(init?.headers).get('authorization');
  upstream.push(`${url.origin} ${url.pathname} ${token}`);
  if (url.pathname === '/models') return Response.json({ data: [{ id: MODEL, supported_endpoints: ENDPOINTS }] });
  assert.equal(url.pathname, '/v1/messages');
  return Response.json({ id: 'msg', type: 'message', role: 'assistant', model: MODEL,
    content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: 1 } });
};

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

async function readyMember(enterpriseId: EnterpriseId): Promise<string> {
  const member = store.reserve([enterpriseId]);
  assert.ok(member);
  const { identity } = member;
  const token = `${enterpriseId}-token`;
  const credential = { enterpriseId, identity, ssoUser: identity, ghLogin: identity, copilotOauthToken: token };
  await importCopilotOauthToken(credential);
  store.update(identity, { state: 'ready', stage: 'ready', verified_at: store.now() });
  return identity;
}

async function message(caller: string): Promise<number> {
  const response = await originalFetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer multi-messages-key',
      'X-User-Identity': caller,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'claude-test-5-2', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
  });
  await response.text();
  return response.status;
}

test('/v1/messages uses each lease\'s enterprise Copilot API and records statistics per enterprise', async () => {
  const policy = store.enterprisePolicies().find((row) => row.id === GHE)!;
  store.updateEnterprisePolicy(GHE, policy.policyVersion, { state: 'active' });
  const gheMember = await readyMember(GHE);
  const gheCaller = `sha256:${'1'.repeat(64)}`;
  assert.equal(await message(gheCaller), 200);
  assert.deepEqual(upstream, [
    `${fixture.GHE_ENDPOINTS.copilotApiBaseUrl} /models Bearer ${GHE}-token`,
    `${fixture.GHE_ENDPOINTS.copilotApiBaseUrl} /v1/messages Bearer ${GHE}-token`,
  ]);

  upstream.length = 0;
  const githubMember = await readyMember(DEFAULT_ENTERPRISE_ID);
  const githubCaller = `sha256:${'2'.repeat(64)}`;
  assert.equal(await message(githubCaller), 200);
  assert.deepEqual(upstream, [
    `${GITHUB_COPILOT} /models Bearer default-token`,
    `${GITHUB_COPILOT} /v1/messages Bearer default-token`,
  ]);

  upstream.length = 0;
  assert.equal(await message(gheCaller), 200, 'the caller keeps its enterprise and member');
  assert.ok(upstream.every((call) => call.startsWith(fixture.GHE_ENDPOINTS.copilotApiBaseUrl)));

  const gheStats = await listRequestStats(GHE, undefined, 10);
  const githubStats = await listRequestStats(DEFAULT_ENTERPRISE_ID, undefined, 10);
  assert.ok(gheStats.length >= 2);
  assert.ok(gheStats.every((stat) => stat.identity === gheMember));
  assert.ok(githubStats.length >= 1);
  assert.ok(githubStats.every((stat) => stat.identity === githubMember));
});
