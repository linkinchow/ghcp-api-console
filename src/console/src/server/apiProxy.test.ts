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

function listening(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve) => server.once('listening', resolve));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}
