import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import cookieSession from 'cookie-session';
import { INTERNAL_AUTH_HEADER } from '@ghcp/shared';
import { requireAdmin, session } from './auth.js';
import { config } from './config.js';
import { serviceProxy } from './apiProxy.js';

test('preserves attachment content type, disposition, and bytes', async () => {
  const payload = Buffer.from('{"id":"diagnostic-id"}\n');
  const upstreamApp = express();
  upstreamApp.get('/api/error-diagnostics/diagnostic-id/download', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="proxy-error-diagnostic-id.json"');
    res.send(payload);
  });
  const upstream = upstreamApp.listen(0, '127.0.0.1');
  await listening(upstream);

  const originalProxyBaseUrl = config.proxyBaseUrl;
  const upstreamAddress = upstream.address() as AddressInfo;
  config.proxyBaseUrl = `http://127.0.0.1:${upstreamAddress.port}`;
  const consoleApp = express();
  consoleApp.use('/api/console/proxy', serviceProxy('proxy', '/api/console/proxy'));
  const consoleServer = consoleApp.listen(0, '127.0.0.1');
  await listening(consoleServer);

  try {
    const consoleAddress = consoleServer.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${consoleAddress.port}/api/console/proxy/error-diagnostics/diagnostic-id/download`,
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(
      response.headers.get('content-disposition'),
      'attachment; filename="proxy-error-diagnostic-id.json"',
    );
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
  } finally {
    config.proxyBaseUrl = originalProxyBaseUrl;
    await close(consoleServer);
    await close(upstream);
  }
});

test('pool settings forwarding requires Console authentication and replaces client service tokens', async () => {
  let calls = 0;
  let forwarded: { token?: string; authorization?: string; body?: unknown } | undefined;
  const upstreamApp = express();
  upstreamApp.use(express.json());
  upstreamApp.patch('/api/user-pool/settings', (req, res) => {
    calls += 1;
    forwarded = { token: req.get(INTERNAL_AUTH_HEADER), authorization: req.get('authorization'), body: req.body };
    res.status(409).json({ error: { code: 'settings_version_conflict', message: 'Reload settings.' } });
  });
  const upstream = upstreamApp.listen(0, '127.0.0.1');
  await listening(upstream);
  const originalUrl = config.proxyBaseUrl;
  const originalToken = config.internalApiToken;
  config.proxyBaseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  config.internalApiToken = 'console-server-token';
  const app = express();
  app.use(express.json());
  app.use(cookieSession({ name: 'test_session', secret: 'pool-forwarding-test', httpOnly: true }));
  app.post('/test-login', (req, res) => {
    session(req).admin = { username: 'test-admin', role: 'admin' };
    res.status(204).end();
  });
  app.use('/api/console/proxy', requireAdmin, serviceProxy('proxy', '/api/console/proxy'));
  const server = app.listen(0, '127.0.0.1');
  await listening(server);
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const body = { expectedVersion: 1, changes: { idle_target: 5, paused: 1 } };
  try {
    const unauthorized = await fetch(`${origin}/api/console/proxy/user-pool/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(calls, 0);
    const login = await fetch(`${origin}/test-login`, { method: 'POST' });
    const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    const response = await fetch(`${origin}/api/console/proxy/user-pool/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, [INTERNAL_AUTH_HEADER]: 'browser-supplied-token', Authorization: 'Bearer browser-key' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'settings_version_conflict');
    assert.equal(calls, 1);
    assert.deepEqual(forwarded, { token: 'console-server-token', authorization: undefined, body });
  } finally {
    config.proxyBaseUrl = originalUrl;
    config.internalApiToken = originalToken;
    await close(server);
    await close(upstream);
  }
});

test('single-enterprise account fields survive Console forwarding without a client-selected route', async () => {
  const enterpriseId = '11111111-2222-4333-8444-555555555555';
  const payload = { items: [{ identity: 'fixture-account', enterpriseId, ssoUser: 'fixture-account', copilotOauthStatus: 'missing' }], total: 1, page: 1, pageSize: 25 };
  let clientEnterprise: string | undefined;
  const upstreamApp = express();
  upstreamApp.get('/api/accounts', (req, res) => {
    clientEnterprise = req.get('x-enterprise-id');
    res.json(payload);
  });
  const upstream = upstreamApp.listen(0, '127.0.0.1');
  await listening(upstream);
  const original = config.proxyBaseUrl;
  config.proxyBaseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const app = express();
  app.use('/api/console/proxy', serviceProxy('proxy', '/api/console/proxy'));
  const server = app.listen(0, '127.0.0.1');
  await listening(server);
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/console/proxy/accounts`, {
      headers: { 'X-Enterprise-Id': 'untrusted-browser-selection' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), payload);
    assert.equal(clientEnterprise, undefined);
  } finally {
    config.proxyBaseUrl = original;
    await close(server);
    await close(upstream);
  }
});

test('new scoped management writes require same origin and preserve safe forwarding headers', async () => {
  const enterpriseId = '11111111-2222-4333-8444-555555555555';
  const paths = ['/management/pool/settings', `/profiles/${enterpriseId}/pool-policy/activate`];
  const seen: Array<{ path: string; body: unknown; enterprise?: string; authorization?: string; token?: string }> = [];
  const upstreamApp = express();
  upstreamApp.use(express.json());
  upstreamApp.use((req, res) => {
    seen.push({ path: req.path, body: req.body, enterprise: req.get('x-enterprise-id'), authorization: req.get('authorization'), token: req.get(INTERNAL_AUTH_HEADER) });
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Retry-After', '7'); res.setHeader('X-Untrusted-Upstream', 'drop-me');
    res.status(409).json({ error: { code: 'policy_version_conflict', message: 'Reload policy.' } });
  });
  const upstream = upstreamApp.listen(0, '127.0.0.1'); await listening(upstream);
  const original = config.proxyBaseUrl, originalToken = config.internalApiToken;
  config.proxyBaseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  config.internalApiToken = 'only-server-token';
  const app = express(); app.use(express.json());
  app.use('/api/console/proxy', serviceProxy('proxy', '/api/console/proxy'));
  const server = app.listen(0, '127.0.0.1'); await listening(server);
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const path of paths) {
      for (const headers of [{}, { Origin: 'https://foreign.test' }, { Origin: 'null' }, { Origin: origin, 'Sec-Fetch-Site': 'cross-site' }] as Record<string, string>[]) {
        const denied = await fetch(`${origin}/api/console/proxy${path}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(denied.status, 403);
      }
      assert.equal(seen.length, 0);
    }
    const body = { expectedVersion: 4, confirm: true };
    const accepted = await fetch(`${origin}/api/console/proxy${paths[1]}`, {
      method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Enterprise-Id': 'attacker-id', Authorization: 'browser-secret', [INTERNAL_AUTH_HEADER]: 'browser-token' }, body: JSON.stringify(body),
    });
    assert.equal(accepted.status, 409); assert.equal(accepted.headers.get('cache-control'), 'no-store'); assert.equal(accepted.headers.get('retry-after'), '7');
    assert.equal(accepted.headers.get('x-untrusted-upstream'), null);
    assert.deepEqual(seen, [{ path: `/api${paths[1]}`, body, enterprise: undefined, authorization: undefined, token: 'only-server-token' }]);
    const httpsOrigin = origin.replace('http:', 'https:');
    const tls = await fetch(`${origin}/api/console/proxy${paths[0]}`, { method: 'PATCH', headers: { Origin: httpsOrigin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(tls.status, 409, 'same-origin browser TLS termination preserves exact host and port');
    for (const headers of [
      { Origin: httpsOrigin }, { Origin: 'https://foreign.test', 'Sec-Fetch-Site': 'same-origin' },
      ...[`${origin}/`, `${origin}/path`, `${origin}?query=1`, `${origin}#hash`, origin.replace('://', '://user@'), 'null'].map(Origin => ({ Origin, 'Sec-Fetch-Site': 'same-origin' })),
    ] as Record<string, string>[]) {
      const denied = await fetch(`${origin}/api/console/proxy${paths[0]}`, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(denied.status, 403, JSON.stringify(headers));
    }
    const metadataOnly = await fetch(`${origin}/api/console/proxy${paths[0]}`, { method: 'PATCH', headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(metadataOnly.status, 409);
    const read = await fetch(`${origin}/api/console/proxy/management/enterprises`);
    assert.equal(read.status, 409, 'read discovery is forwarded without a write-origin requirement');
    const encoded = await fetch(`${origin}/api/console/proxy/%70rofiles/${enterpriseId}/pool-policy`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(encoded.status, 403);
  } finally { config.proxyBaseUrl = original; config.internalApiToken = originalToken; await close(server); await close(upstream); }
});

function listening(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve) => server.once('listening', resolve));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}
