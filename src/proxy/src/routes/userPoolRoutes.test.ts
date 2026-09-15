import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { config } from '../config.js';
import { closeStorage } from '../db/connection.js';
import { importCopilotOauthToken, getAccount } from '../db/accountsRepo.js';
import { listRequestStats } from '../db/requestStatsRepo.js';
import { clearModelsCache } from '../copilot/copilotClient.js';
import { buildApp } from '../server.js';
import { getUserPool, stopUserPool } from '../userPool/runtime.js';
import { UserPoolStore } from '../userPool/store.js';
import { MysqlDeadlineError } from '../userPool/mysqlDeadline.js';

const originalFetch = globalThis.fetch;
const originalConfig = { ...config };
const envKeys = ['ACCOUNT_ROUTING_MODE', 'POOL_ACCOUNT_EMAIL_DOMAIN', 'POOL_WARMUP_MODEL', 'READY_IDLE_TARGET', 'POOL_MAX_ACCOUNTS', 'POOL_REQUEST_TIMEOUT_SECONDS', 'STORAGE_DRIVER'];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const callers = ['a', 'b', 'c'].map((hex) => `sha256:${hex.repeat(64)}`);
let server: Server;
let baseUrl: string;
let store: UserPoolStore;
let now: number;
let members: string[];
let upstreamCalls: Array<{ token: string; path: string; body: Record<string, unknown> }>;
let respond: (path: string, body: Record<string, unknown>, signal?: AbortSignal | null) => Response | Promise<Response>;

beforeEach(async () => {
  Object.assign(process.env, {
    ACCOUNT_ROUTING_MODE: 'caller-lease', POOL_ACCOUNT_EMAIL_DOMAIN: 'accounts.test',
    POOL_WARMUP_MODEL: 'test-model', READY_IDLE_TARGET: '2', POOL_MAX_ACCOUNTS: '10', STORAGE_DRIVER: 'sqlite', POOL_REQUEST_TIMEOUT_SECONDS: '5',
  });
  config.apiKey = 'pool-route-test-key';
  config.dbPath = ':memory:';
  config.requestStatsPerAccountLimit = 100;
  config.claudeCodeOptimized = true;
  const pool = await getUserPool();
  assert.ok(pool instanceof UserPoolStore);
  store = pool;
  now = store.now();
  store.now = () => now;
  members = [];
  for (let i = 0; i < 2; i++) {
    const row = store.reserve()!;
    members.push(row.identity);
    clearModelsCache(row.identity);
    await importCopilotOauthToken({ identity: row.identity, ssoUser: row.identity, ghLogin: `${row.identity}_test`, copilotOauthToken: `test-token-${i}` });
    store.update(row.identity, { state: 'ready', stage: 'ready', verified_at: now });
  }
  upstreamCalls = [];
  respond = (_path, body) => json({ id: 'test', model: 'claude-opus-5.2', content: [{ type: 'text', text: 'ok' }], stream: body.stream });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/models') {
      return json({ data: [{ id: 'claude-opus-5.2', capabilities: { endpoints: ['/v1/messages', '/chat/completions', '/responses'] } }] });
    }
    assert.ok(['/v1/messages', '/v1/messages/count_tokens', '/chat/completions', '/responses'].includes(url.pathname), `Unexpected external call: ${url.pathname}`);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    upstreamCalls.push({ token: new Headers(init?.headers).get('authorization') ?? '', path: url.pathname, body });
    return respond(url.pathname, body, init?.signal);
  };
  server = buildApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  globalThis.fetch = originalFetch;
  await stopUserPool();
  await closeStorage();
  Object.assign(config, originalConfig);
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

async function request(caller = callers[0], path = '/v1/messages', extra: Record<string, unknown> = {}): Promise<Response> {
  return originalFetch(`${baseUrl}${path}`, {
    method: path === '/v1/models' ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'X-User-Identity': caller, 'Content-Type': 'application/json' },
    body: path === '/v1/models' ? undefined : JSON.stringify({ model: 'claude-opus-5-2', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8, ...extra }),
  });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

async function settled(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForHoldsToDrain(): Promise<void> {
  for (let i = 0; i < 100 && members.some((identity) => store.hasHolds(identity)); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(members.every((identity) => !store.hasHolds(identity)));
}

test('storage deadline during admission returns a bounded safe 503 without forwarding', async () => {
  const acquire = store.acquire;
  try {
    store.acquire = () => { throw new MysqlDeadlineError('query'); };
    const response = await request();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '1');
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, 'pool_storage_unavailable');
    assert.equal(upstreamCalls.length, 0);
  } finally { store.acquire = acquire; }
});

test('storage deadline during credential checks uses the same safe 503 envelope', async () => {
  const heartbeat = store.heartbeat;
  try {
    store.heartbeat = () => { throw new MysqlDeadlineError('query'); };
    const response = await request();
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'pool_storage_unavailable');
    assert.equal(upstreamCalls.length, 0);
  } finally { store.heartbeat = heartbeat; }
  await waitForHoldsToDrain();
});

test('Login task protection keeps dispatch and waiting evidence until consumed', async () => {
  const saved = config.internalApiToken;
  config.internalApiToken = 'test-task-protection';
  const url = `${baseUrl}/internal/accounts/${members[0]}/login-task-protection`;
  const headers = { 'X-Internal-Token': config.internalApiToken };
  try {
    assert.equal((await originalFetch(url)).status, 401);
    store.update(members[0], { stage: 'oauth-dispatch', oauth_attempt_id: 'attempt-test', task_id: null });
    let response = await originalFetch(`${url}?taskId=task-test&oauthAttemptId=attempt-test`, { headers });
    assert.deepEqual(await response.json(), { managed: true, referenced: true });
    store.update(members[0], { stage: 'oauth-wait', task_id: 'task-test' });
    response = await originalFetch(`${url}?taskId=task-test&oauthAttemptId=old-attempt`, { headers });
    assert.deepEqual(await response.json(), { managed: true, referenced: true });
    response = await originalFetch(`${url}?taskId=old-task&oauthAttemptId=old-attempt`, { headers });
    assert.deepEqual(await response.json(), { managed: true, referenced: false });
    store.update(members[0], { stage: 'warmup' });
    response = await originalFetch(`${url}?taskId=task-test&oauthAttemptId=attempt-test`, { headers });
    assert.deepEqual(await response.json(), { managed: true, referenced: false });
    response = await originalFetch(`${baseUrl}/internal/accounts/direct-user/login-task-protection?taskId=other`, { headers });
    assert.deepEqual(await response.json(), { managed: false, referenced: false });
  } finally { config.internalApiToken = saved; }
});

test('pool route exclusively maps hashes, reuses members, promotes and records caller/member/lease attribution', async () => {
  for (const path of ['/v1/messages', '/chat/completions', '/responses']) {
    const response = await request(callers[0], path);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { model: string }).model, 'claude-opus-5-2');
  }
  const second = await request(callers[1]);
  assert.equal(second.status, 200);
  await second.text();
  await settled();
  assert.equal(store.leases().length, 2);
  const firstLease = store.leases().find((lease) => lease.caller_id === callers[0])!;
  assert.equal(firstLease.phase, 'active');
  assert.equal(firstLease.expires_at, now + 172800000);
  assert.equal(new Set(upstreamCalls.slice(0, 3).map((call) => call.token)).size, 1);
  assert.notEqual(upstreamCalls[0].token, upstreamCalls[3].token);
  assert.ok(upstreamCalls.every((call) => call.body.model === 'claude-opus-5.2'));
  const stats = await listRequestStats(firstLease.member_identity);
  assert.equal(stats.length, 3);
  assert.ok(stats.every((stat) => stat.callerId === callers[0] && stat.leaseId === firstLease.lease_id));
  assert.equal(await getAccount(callers[0]), undefined);
});

test('exhaustion returns 429 and Retry-After without starting caller onboarding', async () => {
  for (const caller of callers.slice(0, 2)) await (await request(caller)).text();
  const response = await request(callers[2]);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '30');
  assert.equal((await response.json() as any).error.code, 'pool_exhausted');
  assert.equal(upstreamCalls.length, 2);
  assert.equal(await getAccount(callers[2]), undefined);
});

test('hash identity fails closed and malformed models do not allocate', async () => {
  for (const caller of ['user@example.com', 'alice', 'sk-secret', `sha256:${'a'.repeat(63)}`]) {
    const response = await request(caller);
    assert.equal(response.status, 403);
    await response.text();
  }
  const response = await request(callers[0], '/v1/messages', { model: null });
  assert.equal(response.status, 400);
  await response.text();
  assert.equal(store.leases().length, 0);
  assert.equal(upstreamCalls.length, 0);
});

test('Express case-insensitive, trailing-slash and HEAD routes cannot bypass pool identity routing', async () => {
  const response = await request(callers[0], '/V1/MESSAGES/');
  assert.equal(response.status, 200);
  await response.text();
  const head = await originalFetch(`${baseUrl}/V1/MODELS/`, {
    method: 'HEAD', headers: { Authorization: `Bearer ${config.apiKey}`, 'X-User-Identity': callers[0] },
  });
  assert.equal(head.status, 200);
  assert.equal(await getAccount(callers[0]), undefined);
  assert.ok(store.leases().every((lease) => lease.member_identity !== callers[0]));
});

test('same caller concurrent requests use one exclusive member', async () => {
  const responses = await Promise.all(Array.from({ length: 30 }, () => request()));
  await Promise.all(responses.map(async (response) => { assert.equal(response.status, 200); await response.text(); }));
  await settled();
  assert.equal(store.leases().length, 1);
  assert.equal(new Set(upstreamCalls.map((call) => call.token)).size, 1);
  assert.equal(store.counts().ready_idle, 1);
});

test('401 quarantines only the selected member and does not replay generation', async () => {
  respond = () => json({ error: 'unauthorized' }, 401);
  const response = await request();
  assert.equal(response.status, 401);
  await response.text();
  await settled();
  assert.equal(upstreamCalls.length, 1);
  assert.equal(store.inventory(members[0])?.state, 'failed');
  assert.equal(store.inventory(members[0])?.stage, 'synced');
  assert.equal(store.inventory(members[0])?.attempts, 0);
  assert.equal(store.pending()?.identity, members[0]);
  assert.equal((await getAccount(members[0]))?.copilotOauthStatus, 'expired');
  assert.equal((await getAccount(members[1]))?.copilotOauthStatus, 'valid');
});

test('model discovery 401 schedules automatic repair without a caller lease', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init) => new URL(String(input)).pathname === '/models'
    ? json({ error: 'unauthorized' }, 401) : previous(input, init);
  const response = await request(callers[0], '/v1/models');
  assert.equal(response.status, 401);
  await response.text();
  await waitForHoldsToDrain();
  assert.equal(store.leases().length, 0);
  assert.equal(store.inventory(members[0])?.stage, 'synced');
  assert.equal(store.inventory(members[0])?.attempts, 0);
  assert.equal(store.pending()?.identity, members[0]);
});

test('broken model-catalog 401 body still schedules credential recovery', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init) => new URL(String(input)).pathname === '/models'
    ? new Response(new ReadableStream({ start(controller) { controller.error(new Error('broken upstream body')); } }), { status: 401 })
    : previous(input, init);
  const response = await request(callers[0], '/v1/models');
  assert.equal(response.status, 401);
  await response.text();
  await waitForHoldsToDrain();
  assert.equal(store.inventory(members[0])?.stage, 'synced');
  assert.equal(store.inventory(members[0])?.reauth_count, 1);
});

test('late 401 cannot invalidate an administrator replacement token or schedule another login', async () => {
  respond = async () => {
    await importCopilotOauthToken({ identity: members[0], ssoUser: members[0], copilotOauthToken: 'replacement-valid-token' });
    return json({ error: 'old token rejected' }, 401);
  };
  const response = await request();
  assert.equal(response.status, 401);
  await response.text();
  await waitForHoldsToDrain();
  assert.equal((await getAccount(members[0]))?.copilotOauthToken, 'replacement-valid-token');
  assert.equal((await getAccount(members[0]))?.copilotOauthStatus, 'valid');
  assert.equal(store.inventory(members[0])?.reauth_count, 0);
  assert.equal(store.inventory(members[0])?.stage, 'warmup');
});

test('independent admin reauthorization cannot race a managed pool member', async () => {
  const token = config.internalApiToken;
  config.internalApiToken = 'test-internal-only';
  try {
    const response = await originalFetch(`${baseUrl}/api/accounts/${members[0]}/copilot-oauth/reauthorize`, {
      method: 'POST', headers: { 'X-Internal-Token': config.internalApiToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssoPassword: 'unused-test-password' }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as any).error.code, 'pool_member_managed');
    assert.equal((await getAccount(members[0]))?.copilotOauthStatus, 'valid');
    assert.equal(upstreamCalls.length, 0);
  } finally { config.internalApiToken = token; }
});

test('pool mode blocks credential import before validating or overwriting any token', async () => {
  const saved = config.internalApiToken;
  config.internalApiToken = 'test-import-internal';
  try {
    const before = await getAccount(members[1]);
    const response = await originalFetch(`${baseUrl}/api/accounts/copilot-oauth-token/import`, {
      method: 'POST', headers: { 'X-Internal-Token': config.internalApiToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ csvText: `name,copilotOauthToken\n${members[1]},test-token-0` }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as any).error.code, 'pool_member_managed');
    assert.deepEqual(await getAccount(members[1]), before);
    assert.equal(upstreamCalls.length, 0);
    const membership = await originalFetch(`${baseUrl}/internal/accounts/by-sso-user/${members[0]}/pool-membership`, { headers: { 'X-Internal-Token': config.internalApiToken } });
    assert.deepEqual(await membership.json(), { managed: true });
    const unknown = await originalFetch(`${baseUrl}/internal/accounts/by-sso-user/not-a-member/pool-membership`, { headers: { 'X-Internal-Token': config.internalApiToken } });
    assert.deepEqual(await unknown.json(), { managed: false });
  } finally { config.internalApiToken = saved; }
});

test('429 retains ownership, enforces cooldown, and never retries another member', async () => {
  await (await request()).text();
  const lease = store.leases()[0];
  now += 10000;
  respond = () => json({ error: 'rate limited' }, 429, { 'Retry-After': '90' });
  const failed = await request();
  assert.equal(failed.status, 429);
  assert.equal(failed.headers.get('retry-after'), '90');
  await failed.text();
  await settled();
  assert.equal(store.leases()[0].lease_id, lease.lease_id);
  assert.equal(store.leases()[0].expires_at, lease.expires_at);
  const blocked = await request();
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json() as any).error.code, 'member_cooling');
  assert.equal(upstreamCalls.length, 2);
  assert.equal(store.counts().ready_idle, 1);
});

test('5xx, generic 403 and invalid 200 bodies never promote provisional leases', async () => {
  for (const [status, body] of [[500, { error: 'busy' }], [403, { error: 'denied' }], [200, { error: 'in-band' }]] as const) {
    respond = () => json(body, status);
    const response = await request();
    assert.equal(response.status, status);
    await response.text();
    await settled();
    assert.equal(store.leases()[0].phase, 'provisional');
    assert.equal(store.leases()[0].last_success_at, null);
  }
  assert.equal(new Set(upstreamCalls.map((call) => call.token)).size, 1);
});

test('stream promotes only after valid terminal event and rejects in-band errors and early EOF', async () => {
  for (const text of [
    'data: {"type":"message_start","message":{"model":"claude-opus-5.2"}}\n\n',
    'event: error\ndata: {"type":"error","error":{"message":"busy"}}\n\ndata: {"type":"message_stop"}\n\n',
  ]) {
    respond = () => new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
    await (await request(callers[0], '/v1/messages', { stream: true })).text();
    await settled();
    assert.equal(store.leases()[0].phase, 'provisional');
  }
  respond = () => new Response('data: {"type":"message_start","message":{"model":"claude-opus-5.2"}}\n\ndata: {"type":"message_stop"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  const text = await (await request(callers[0], '/v1/messages', { stream: true })).text();
  assert.match(text, /claude-opus-5-2/);
  await settled();
  assert.equal(store.leases()[0].phase, 'active');
});

test('request deadline cancels upstream and does not promote or leave an active hold', async () => {
  let aborted = false;
  respond = (_path, _body, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  });
  const response = await request();
  assert.equal(response.status, 504);
  assert.equal((await response.json() as any).error.code, 'pool_request_timeout');
  await waitForHoldsToDrain();
  assert.equal(aborted, true);
  assert.equal(store.leases()[0].phase, 'provisional');
  assert.equal(store.hasHolds(members[0]), false);
});

test('disconnect cancels an in-flight upstream without renewing or replaying', async () => {
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  let cancelled!: () => void;
  const cancel = new Promise<void>((resolve) => { cancelled = resolve; });
  respond = (_path, _body, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => { reject(signal.reason); cancelled(); }, { once: true });
    started();
  });
  const controller = new AbortController();
  const pending = originalFetch(`${baseUrl}/v1/messages`, {
    method: 'POST', signal: controller.signal,
    headers: { Authorization: `Bearer ${config.apiKey}`, 'X-User-Identity': callers[0], 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5-2', messages: [], max_tokens: 8 }),
  });
  await start;
  controller.abort();
  await assert.rejects(pending);
  await cancel;
  await waitForHoldsToDrain();
  assert.equal(store.leases()[0].phase, 'provisional');
  assert.equal(store.hasHolds(members[0]), false);
  assert.equal(upstreamCalls.length, 1);
});

test('new-caller catalog and count-token requests release inventory without a provisional caller lease', async () => {
  for (const path of ['/v1/models', '/v1/messages/count_tokens']) {
    const response = await request(callers[0], path);
    assert.equal(response.status, 200);
    await response.text();
    await waitForHoldsToDrain();
    assert.equal(store.leases().length, 0);
    assert.equal(store.counts().ready_idle, 2);
  }
});

test('model listing and token counting never renew a successful generation lease', async () => {
  await (await request()).text();
  const lease = store.leases()[0];
  now += 60000;
  for (const path of ['/v1/models', '/v1/messages/count_tokens']) {
    const response = await request(callers[0], path);
    assert.equal(response.status, 200);
    await response.text();
  }
  await settled();
  assert.equal(store.leases()[0].expires_at, lease.expires_at);
  assert.equal(store.leases()[0].last_success_at, lease.last_success_at);
});
