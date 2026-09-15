import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { SsoUserDto, LoginTaskDto } from '@ghcp/shared';
import { config } from '../config.js';
import { getStorage, closeStorage } from '../db/connection.js';
import { buildApp } from '../server.js';
import { getUserPool, stopUserPool } from './runtime.js';
import { readPoolConfig } from './config.js';
import { PrewarmWorker } from './worker.js';
import { realProvisioner } from './provisioner.js';
import { UserPoolStore } from './store.js';

test('empty SQLite prewarms, serves exclusive HTTP callers, replenishes idle inventory and recycles expired leases', async () => {
  const settings = {
    ACCOUNT_ROUTING_MODE: 'caller-lease', STORAGE_DRIVER: 'sqlite', POOL_ACCOUNT_EMAIL_DOMAIN: 'pool.example.test',
    POOL_WARMUP_MODEL: 'claude-test-5-2', READY_IDLE_TARGET: '2', POOL_MAX_ACCOUNTS: '5', CALLER_LEASE_TTL_SECONDS: '60',
  };
  const savedEnv = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  const savedConfig = { ...config };
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, settings);
  config.dbPath = ':memory:';
  config.storageDriver = 'sqlite';
  config.apiKey = 'mock-proxy-key';
  config.internalApiToken = 'mock-internal-key';
  config.ssoBaseUrl = 'http://sso.mock.test';
  config.loginBaseUrl = 'http://login.mock.test';
  config.copilotApiBaseUrl = 'http://copilot.mock.test';
  const store = await getUserPool();
  assert.ok(store instanceof UserPoolStore);
  let now = Date.now();
  store.now = () => now;
  const users = new Map<string, SsoUserDto>();
  const tasks = new Map<string, LoginTaskDto>();
  const inferenceTokens: string[] = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.hostname !== 'copilot.mock.test') assert.equal(new Headers(init?.headers).get('x-internal-token'), config.internalApiToken);
    if (url.hostname === 'sso.mock.test') {
      if (url.pathname === '/api/users' && init?.method === 'POST') {
        assert.equal(body.role, 'user');
        const createdAt = new Date(now).toISOString();
        const user: SsoUserDto = { ssoUser: body.ssoUser, email: body.email, role: 'user', emuStatus: 'not_synced', copilotSeatStatus: 'unassigned', createdAt, updatedAt: createdAt };
        assert.equal(users.has(user.ssoUser), false);
        users.set(user.ssoUser, user);
        return json(user, 201);
      }
      if (url.pathname === '/api/users/batch') {
        assert.equal(body.createOnly, true);
        assert.equal(body.assignCopilotSeat, false);
        const user = users.get(body.ssoUsers[0])!;
        user.emuStatus = 'active'; user.ghScimId = `scim-${user.ssoUser}`; user.ghLogin = `${user.ssoUser}_test`;
        return json({ rows: [{ ssoUser: user.ssoUser, status: 'success', user }] });
      }
      const [, , , identity, action] = url.pathname.split('/');
      const user = users.get(identity);
      if (!user) return json({}, 404);
      if (action === 'copilot-seat') { user.copilotSeatStatus = 'assigned'; return json(user); }
      if (action === 'login-credentials') {
        assert.equal(body.expectedCreatedAt, user.createdAt);
        assert.equal(body.expectedEmail, user.email);
        return json({ user, passwordForLogin: 'mock-password' });
      }
      assert.equal(init?.method, 'GET');
      return json(user);
    }
    if (url.hostname === 'login.mock.test') {
      if (init?.method === 'POST') {
        assert.equal(body.ssoPassword, 'mock-password');
        assert.equal(users.get(body.identity)?.copilotSeatStatus, 'assigned');
        const task: LoginTaskDto = { id: `task-${body.identity}`, identity: body.identity, ssoUser: body.ssoUser, ghLogin: body.ghLogin, oauthAttemptId: body.oauthAttemptId, ssoType: 'custom', status: 'success', attempts: 1, createdAt: new Date(now).toISOString() };
        assert.equal(tasks.has(task.id), false);
        await getStorage().saveCopilotOauthToken(task.identity, body.oauthAttemptId, `mock-token-${task.identity}`, task.ghLogin);
        tasks.set(task.id, task);
        return json(task, 202);
      }
      return json(tasks.get(url.pathname.split('/').at(-1)!));
    }
    assert.equal(url.hostname, 'copilot.mock.test', `Unexpected outbound host ${url.hostname}`);
    if (url.pathname === '/models') return json({ data: [{ id: 'claude-test-5.2', capabilities: { endpoints: ['/v1/messages'] } }] });
    assert.equal(url.pathname, '/v1/messages');
    assert.equal(body.model, 'claude-test-5.2');
    if (body.messages[0].content !== 'Reply OK') inferenceTokens.push(new Headers(init?.headers).get('authorization')!);
    return json({ id: 'mock-message', model: body.model, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }] });
  };
  const worker = new PrewarmWorker(store, realProvisioner(store, readPoolConfig(process.env)), 5000);
  const server = buildApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (number: number) => {
    const response = await originalFetch(`${base}/v1/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'X-User-Identity': `sha256:${number.toString(16).padStart(64, '0')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test-5-2', messages: [{ role: 'user', content: 'hello' }], max_tokens: 8 }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { model: string }).model, 'claude-test-5-2');
  };
  try {
    assert.equal(store.counts().total, 0);
    for (let step = 0; step < 30 && store.counts().ready_idle < 2; step++) await worker.tick();
    assert.equal(store.counts().ready_idle, 2);
    assert.equal(users.size, 2);
    await request(1); await request(2); await request(1);
    assert.equal(store.counts().leased, 2);
    assert.equal(store.counts().ready_idle, 0);
    assert.notEqual(inferenceTokens[0], inferenceTokens[1]);
    assert.equal(inferenceTokens[0], inferenceTokens[2]);
    for (let step = 0; step < 30 && store.counts().ready_idle < 2; step++) await worker.tick();
    assert.equal(store.counts().ready_idle, 2);
    assert.equal(store.counts().total, 4);
    assert.equal(tasks.size, 4);
    now += 61000;
    store.reclaim();
    assert.equal(store.counts().leased, 0);
    assert.equal(store.counts().ready_idle, 4);
    await request(3);
    assert.ok(inferenceTokens.slice(0, 2).includes(inferenceTokens[3]));
    assert.equal(store.counts().total, 4);
    assert.equal([...users.values()].every((user) => user.copilotSeatStatus === 'assigned'), true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await worker.stop();
    await stopUserPool();
    await closeStorage();
    globalThis.fetch = originalFetch;
    Object.assign(config, savedConfig);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
