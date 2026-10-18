import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { config } from '../config.js';
import {
  GHE_ENDPOINTS,
  GHE_ENTERPRISE_ID,
  GHE_MODELS_ADMIN,
  installEnterpriseFixture,
  SECOND_ENTERPRISE_ID,
} from '../testing/enterpriseFixture.js';
import { createEnterpriseApiRouter } from './enterpriseRoutes.js';

const TOKEN = 'models-enterprise-internal';
const ADMIN_TOKEN = 'synthetic-contoso-admin-token';

/** Every outbound call as `METHOD url`; only the GHE.com admin's hosts answer. */
const calls: string[] = [];
const originalFetch = globalThis.fetch;

async function startApp(t: test.TestContext): Promise<string> {
  const fixture = installEnterpriseFixture();
  const savedToken = config.internalApiToken;
  config.internalApiToken = TOKEN;
  process.env[GHE_MODELS_ADMIN.tokenVariable] = ADMIN_TOKEN;
  globalThis.fetch = fakeGithub;
  const app = express();
  app.use('/api/enterprises/:enterpriseId', createEnterpriseApiRouter());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
    globalThis.fetch = originalFetch;
    config.internalApiToken = savedToken;
    delete process.env[GHE_MODELS_ADMIN.tokenVariable];
    fixture.restore();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/enterprises`;
}

async function fakeGithub(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  calls.push(`${init?.method ?? 'GET'} ${url.origin}${url.pathname}`);
  assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${ADMIN_TOKEN}`);
  if (url.origin === GHE_ENDPOINTS.apiBaseUrl && url.pathname === '/user') {
    return Response.json({ login: GHE_MODELS_ADMIN.githubLogin, id: Number(GHE_MODELS_ADMIN.githubUserId) });
  }
  if (url.origin === GHE_ENDPOINTS.copilotApiBaseUrl && url.pathname === '/models') {
    return Response.json({ data: [{ id: 'claude-sonnet-4.5', supported_endpoints: ['/v1/messages'] }] });
  }
  return new Response('unexpected', { status: 599 });
}

async function getModels(base: string, enterpriseId: string): Promise<{ status: number; body: any }> {
  const response = await originalFetch(`${base}/${enterpriseId}/models`, { headers: { 'X-Internal-Token': TOKEN } });
  return { status: response.status, body: await response.json() };
}

test('each enterprise lists Models with its own admin and endpoints and never falls back', async (t) => {
  const base = await startApp(t);
  const ghe = await getModels(base, GHE_ENTERPRISE_ID);
  assert.equal(ghe.status, 200, JSON.stringify(ghe.body));
  assert.equal(ghe.body.adminLogin, GHE_MODELS_ADMIN.githubLogin);
  assert.deepEqual(calls, [
    `GET ${GHE_ENDPOINTS.apiBaseUrl}/user`,
    `GET ${GHE_ENDPOINTS.copilotApiBaseUrl}/models`,
  ]);

  calls.length = 0;
  for (const enterpriseId of ['default', SECOND_ENTERPRISE_ID]) {
    const unconfigured = await getModels(base, enterpriseId);
    assert.equal(unconfigured.status, 409, enterpriseId);
    assert.equal(unconfigured.body.error.code, 'models_admin_not_configured');
  }
  assert.deepEqual(calls, [], 'no pool, direct or other-enterprise credential is tried');
  assert.equal((await getModels(base, 'unknown-co')).status, 404);
});
