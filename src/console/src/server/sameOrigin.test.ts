import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import express from 'express';
import { serviceProxy } from './apiProxy.js';
import { buildApp } from './app.js';
import { config } from './config.js';

type Target = 'proxy' | 'sso' | 'login';
type Write = [Target, string, string];

const MOUNTS: Record<Target, string> = {
  proxy: '/api/console/proxy',
  sso: '/api/console/sso',
  login: '/api/console/login-service',
};

/** Every forwarded write the Console UI issues, including the legacy unscoped ones. */
const WRITES: Write[] = [
  ['proxy', 'DELETE', '/accounts/legacy-identity'],
  ['proxy', 'PATCH', '/accounts/legacy-identity'],
  ['proxy', 'POST', '/accounts/legacy-identity/copilot-oauth/reauthorize'],
  ['proxy', 'DELETE', '/error-diagnostics'],
  ['proxy', 'PATCH', '/user-pool/settings'],
  ['proxy', 'POST', '/user-pool/reconcile'],
  ['proxy', 'PATCH', '/enterprises/default/pool-policy'],
  ['proxy', 'POST', '/enterprises/default/accounts/copilot-oauth-token/import'],
  ['proxy', 'POST', '/enterprises/default/accounts/operations/preview'],
  ['proxy', 'POST', '/enterprises/default/accounts/operations/op-1/execute'],
  ['proxy', 'POST', '/enterprises/default/accounts/identity-1/copilot-oauth/reauthorize'],
  ['proxy', 'POST', '/enterprises/default/user-pool/accounts/member-1/disable'],
  ['proxy', 'POST', '/enterprises/default/user-pool/leases/lease-1/release'],
  ['sso', 'PATCH', '/enterprises/default/settings/runtime'],
  ['sso', 'POST', '/enterprises/default/users'],
  ['sso', 'PATCH', '/enterprises/default/users/user-1'],
  ['sso', 'POST', '/enterprises/default/users/import'],
  ['sso', 'POST', '/enterprises/default/users/batch'],
  ['sso', 'POST', '/enterprises/default/users/emu/import/plans'],
  ['sso', 'DELETE', '/enterprises/default/users/emu/import/plans/plan-1'],
  ['sso', 'POST', '/enterprises/default/users/operations/preview'],
  ['sso', 'POST', '/enterprises/default/ai-credits/usage/refresh'],
  ['login', 'PATCH', '/settings/runtime'],
  ['login', 'POST', '/enterprises/default/tasks/operations/preview'],
  ['login', 'POST', '/enterprises/default/tasks/task-1/retry'],
  ['login', 'DELETE', '/enterprises/default/tasks/task-1'],
];

const CROSS_SITE: Array<Record<string, string>> = [
  { Origin: 'https://attacker.example' },
  { Origin: 'null' },
  { Origin: 'not a url' },
  { 'Sec-Fetch-Site': 'cross-site' },
  { Origin: 'SELF', 'Sec-Fetch-Site': 'cross-site' },
];

async function listen(t: TestContext, app: express.Express): Promise<string> {
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** One fake upstream for all three services; records every forwarded request. */
async function relays(t: TestContext): Promise<{ origin: string; forwarded: string[] }> {
  const forwarded: string[] = [];
  const upstream = express();
  upstream.use((req, res) => {
    forwarded.push(`${req.method} ${req.path}`);
    res.json({ ok: true });
  });
  const upstreamUrl = await listen(t, upstream);
  const saved = { proxy: config.proxyBaseUrl, sso: config.ssoBaseUrl, login: config.loginBaseUrl };
  Object.assign(config, { proxyBaseUrl: upstreamUrl, ssoBaseUrl: upstreamUrl, loginBaseUrl: upstreamUrl });
  t.after(() => Object.assign(config, { proxyBaseUrl: saved.proxy, ssoBaseUrl: saved.sso, loginBaseUrl: saved.login }));
  const app = express();
  app.use(express.json());
  for (const [target, mount] of Object.entries(MOUNTS)) app.use(mount, serviceProxy(target as Target, mount));
  return { origin: await listen(t, app), forwarded };
}

function headersFor(origin: string, headers: Record<string, string>): Record<string, string> {
  const entries = Object.entries(headers).map(([key, value]) => [key, value === 'SELF' ? origin : value] as const);
  const resolved = Object.fromEntries(entries);
  return { 'Content-Type': 'application/json', ...resolved };
}

async function send(origin: string, [target, method, path]: Write, headers: Record<string, string>): Promise<number> {
  const init = { method, headers: headersFor(origin, headers), body: '{}' };
  const response = await fetch(`${origin}${MOUNTS[target]}${path}`, init);
  await response.arrayBuffer();
  return response.status;
}

test('every forwarded write rejects cross-site and null origins before reaching a service', async (t) => {
  const { origin, forwarded } = await relays(t);
  for (const write of WRITES) {
    for (const headers of CROSS_SITE) {
      const status = await send(origin, write, headers);
      assert.equal(status, 403, `${write.join(' ')} with ${JSON.stringify(headers)}`);
    }
  }
  assert.deepEqual(forwarded, []);
});

test('same-origin, public-base-URL and Origin-less writes are forwarded', async (t) => {
  const { origin, forwarded } = await relays(t);
  const savedPublic = config.publicBaseUrl;
  config.publicBaseUrl = 'https://console.example.test/base';
  t.after(() => { config.publicBaseUrl = savedPublic; });
  const accepted: Array<Record<string, string>> = [
    {},
    { Origin: 'SELF', 'Sec-Fetch-Site': 'same-origin' },
    { Origin: 'https://console.example.test' },
    { 'Sec-Fetch-Site': 'none' },
  ];
  for (const write of WRITES) {
    for (const headers of accepted) assert.equal(await send(origin, write, headers), 200, write.join(' '));
  }
  assert.equal(forwarded.length, WRITES.length * accepted.length);
});

test('cross-site reads are still forwarded; only writes are guarded', async (t) => {
  const { origin, forwarded } = await relays(t);
  const headers = { Origin: 'https://attacker.example', 'Sec-Fetch-Site': 'cross-site' };
  const response = await fetch(`${origin}/api/console/proxy/enterprises`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(forwarded, ['GET /api/enterprises']);
});

test('Console setup, login, logout and password writes require the same origin', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'console-same-origin-'));
  const savedFile = config.adminsFile;
  config.adminsFile = join(directory, 'admins.json');
  t.after(async () => {
    config.adminsFile = savedFile;
    await rm(directory, { recursive: true, force: true });
  });
  const origin = await listen(t, buildApp());
  const routes: Array<[string, string]> = [
    ['POST', '/api/console/setup'],
    ['POST', '/api/console/login'],
    ['POST', '/api/console/logout'],
    ['PATCH', '/api/console/password'],
    ['DELETE', '/api/console/proxy/error-diagnostics'],
  ];
  for (const [method, path] of routes) {
    for (const headers of CROSS_SITE) {
      const response = await fetch(`${origin}${path}`, { method, headers: headersFor(origin, headers), body: '{}' });
      assert.equal(response.status, 403, `${method} ${path} with ${JSON.stringify(headers)}`);
      const body = await response.json() as { error: { code: string } };
      assert.equal(body.error.code, 'cross_site_request_rejected');
    }
  }
  const logout = await fetch(`${origin}/api/console/logout`, { method: 'POST', headers: { Origin: origin } });
  assert.equal(logout.status, 204);
  const setup = await fetch(`${origin}/api/console/setup`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'same-origin-password' }),
  });
  assert.equal(setup.status, 201);
});
