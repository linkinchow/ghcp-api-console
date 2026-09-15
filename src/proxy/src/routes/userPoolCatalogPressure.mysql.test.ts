import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import type { PoolRequest } from '../userPool/runtime.js';

const mysqlUrl = process.env.MYSQL_TEST_URL;
const enabled = Boolean(mysqlUrl) && process.env.MYSQL_POOL_TEST_DISPOSABLE === '1';
const options = {
  skip: enabled ? false : 'Requires root loopback MYSQL_TEST_URL (ghcp_pool_test_*) and MYSQL_POOL_TEST_DISPOSABLE=1; creates/drops fresh sibling databases.',
  timeout: 30_000, concurrency: false,
};
const callers = ['a', 'b', 'c'].map(hex => `sha256:${hex.repeat(64)}`);
const realFetch = globalThis.fetch;
const model = { id: 'claude-opus-5.2', capabilities: { endpoints: ['/v1/messages'] } };
const encoder = new TextEncoder();
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}

async function loadModules() {
  const [express, configuration, connection, accounts, client, runtime, store, storage, auth, identity, routes] = await Promise.all([
    import('express'), import('../config.js'), import('../db/connection.js'), import('../db/accountsRepo.js'),
    import('../copilot/copilotClient.js'), import('../userPool/runtime.js'), import('../userPool/mysqlStore.js'),
    import('../db/mysqlStorage.js'), import('../auth/apiKey.js'), import('../auth/identityHeader.js'), import('./compatible.js'),
  ]);
  return { express: express.default, ...configuration, ...connection, ...accounts, ...client, ...runtime,
    ...store, ...storage, ...auth, ...identity, ...routes };
}

type Call = { token: string; path: string; signal: AbortSignal; body?: Record<string, unknown> };
type ModelCall = Call & { release: () => void; cancelled: boolean; bytes: number };
type WireResult = { status: number; text: string; method: string };

/**
 * Actual HTTP -> production auth/admission/compatible routes -> real MysqlStorage.
 * Two Express listeners share ONE process, runtime and model cache. This is an
 * engine-backed component test, not independent-process/multi-replica evidence.
 * Nothing connects or imports dotenv-bearing application modules before the gate.
 * The database named by MYSQL_TEST_URL is never selected, modified or dropped.
 */
async function fixture(t: TestContext) {
  assert.equal(process.env.MYSQL_POOL_TEST_DISPOSABLE, '1');
  const url = new URL(mysqlUrl!);
  assert.equal(url.protocol, 'mysql:');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Refusing non-loopback MySQL');
  assert.equal(decodeURIComponent(url.username), 'root', 'A disposable root test connection is required');
  assert.match(url.pathname, /^\/ghcp_pool_test_[a-z0-9_]+$/, 'Refusing a non-test database URL');
  assert.equal(url.search, '', 'Connection overrides are forbidden');
  assert.equal(url.hash, '', 'URL fragments are forbidden');
  const database = `ghcp_pool_test_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(url);
  adminUrl.pathname = '/';
  url.pathname = `/${database}`;
  const env = {
    DOTENV_CONFIG_PATH: join(tmpdir(), `catalog-pressure-mysql-no-dotenv-${randomUUID()}.env`),
    STORAGE_DRIVER: 'mysql', MYSQL_URL: url.toString(), MYSQL_SSL_MODE: 'disabled', MYSQL_SSL_CA_PATH: '',
    MYSQL_CONNECTION_LIMIT: '10', DB_PATH: ':memory:', PORT: '3000', ACCOUNT_ROUTING_MODE: 'caller-lease',
    API_KEY: 'catalog-pressure-mysql-synthetic-key', INTERNAL_API_TOKEN: 'catalog-pressure-mysql-internal',
    IDENTITY_HEADER: 'X-User-Identity', IDENTITY_HEADER_REQUIRED: 'true', CLAUDE_CODE_OPTIMIZED: 'true',
    COPILOT_API_BASE_URL: 'http://127.0.0.1:1/catalog-pressure-mysql-upstream',
    SSO_BASE_URL: 'http://127.0.0.1:1', LOGIN_BASE_URL: 'http://127.0.0.1:1',
    PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false', POOL_ACCOUNT_EMAIL_DOMAIN: 'catalog-pressure-mysql.test',
    POOL_WARMUP_MODEL: 'claude-opus-5-2', READY_IDLE_TARGET: '2', POOL_MAX_ACCOUNTS: '2',
    POOL_REQUEST_TIMEOUT_SECONDS: '10', CALLER_LEASE_TTL_SECONDS: '120', PROVISIONAL_LEASE_TTL_SECONDS: '30',
    PREWARM_POLL_SECONDS: '1', PREWARM_CONCURRENCY: '1', POOL_LOGIN_MAX_PENDING: '1',
    POOL_EXHAUSTED_RETRY_AFTER_SECONDS: '1',
  };
  const savedEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  let modules: Awaited<ReturnType<typeof loadModules>> | undefined;
  let savedConfig: NonNullable<typeof modules>['config'] | undefined;
  let admin: Connection | undefined;
  let created = false;
  const servers: Server[] = [];
  const controllers: AbortController[] = [];
  const members: string[] = [];
  const tokens = new Map<string, string>();
  const events = new EventEmitter();
  const contexts = new Map<string, PoolRequest>();
  const joined = new Set<string>();
  const finished = new Set<string>();
  const live = new Set<string>();
  const calls: Call[] = [];
  const models: ModelCall[] = [];
  const inferenceGate = deferred();
  let blockInference = true;
  let restoreFinish = () => {};
  let sequence = 0;

  async function until(predicate: () => boolean, label: string, timeout = 5000) {
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const check = () => { if (predicate()) { cleanup(); resolve(); } };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Barrier timed out: ${label}`)); }, timeout);
      const cleanup = () => { clearTimeout(timer); events.off('change', check); };
      events.on('change', check);
      check();
    });
  }
  t.after(async () => {
    controllers.forEach(controller => controller.abort());
    models.forEach(call => call.release());
    inferenceGate.resolve();
    servers.forEach(server => server.closeAllConnections());
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    try { await until(() => live.size === 0, 'cleanup request holds drain'); }
    finally {
      restoreFinish();
      globalThis.fetch = realFetch;
      try {
        if (modules) {
          members.forEach(modules.clearModelsCache);
          await modules.stopUserPool();
          await modules.closeStorage();
        }
      } finally {
        try {
          if (admin && created) await admin.query({ sql: `DROP DATABASE \`${database}\``, timeout: 5000 });
        } finally {
          await admin?.end();
          if (modules && savedConfig) Object.assign(modules.config, savedConfig);
          for (const key of Object.keys(env)) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
          }
        }
      }
    }
  });

  Object.assign(process.env, env);
  // No real fetch fallback, even for unknown URLs. Client HTTP uses the captured
  // native fetch and only URLs constructed from our ephemeral loopback listeners.
  globalThis.fetch = async (input, init) => {
    const target = new URL(String(input));
    assert.equal(target.origin, 'http://127.0.0.1:1');
    assert.ok(target.pathname.startsWith('/catalog-pressure-mysql-upstream/'));
    const path = target.pathname.slice('/catalog-pressure-mysql-upstream'.length);
    assert.ok(['/models', '/v1/messages', '/v1/messages/count_tokens'].includes(path));
    const token = new Headers(init?.headers).get('authorization') ?? '';
    assert.ok(tokens.has(token), 'Only synthetic member credentials may be forwarded');
    assert.ok(init?.signal);
    const call: Call = { token, path, signal: init.signal,
      body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined };
    calls.push(call);
    if (path === '/models') {
      const gate = deferred();
      const current: ModelCall = { ...call, release: gate.resolve, cancelled: false, bytes: 0 };
      models.push(current);
      let first = true;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (first) {
            first = false;
            const prefix = encoder.encode('{"data":[');
            current.bytes += prefix.byteLength;
            controller.enqueue(prefix);
            events.emit('change');
            return;
          }
          await gate.promise;
          if (current.cancelled) return;
          const suffix = encoder.encode(`${JSON.stringify(model)}]}`);
          current.bytes += suffix.byteLength;
          controller.enqueue(suffix);
          controller.close();
        },
        cancel() { current.cancelled = true; gate.resolve(); events.emit('change'); },
      }, { highWaterMark: 0 });
      events.emit('change');
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    }
    events.emit('change');
    if (path === '/v1/messages/count_tokens') return json({ input_tokens: 7 });
    if (blockInference) await inferenceGate.promise;
    call.signal.throwIfAborted();
    return json({ id: 'catalog-pressure-mysql-result', model: model.id, content: [{ type: 'text', text: 'OK' }] });
  };
  const { createConnection } = await import('mysql2/promise');
  admin = await createConnection({ uri: adminUrl.toString(), connectTimeout: 3000 });
  await admin.query({ sql: `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`, timeout: 5000 });
  created = true;
  modules = await loadModules();
  savedConfig = { ...modules.config };
  Object.assign(modules.config, { storageDriver: 'mysql', mysqlUrl: url.toString(), mysqlSslMode: 'disabled',
    mysqlConnectionLimit: 10, apiKey: env.API_KEY, identityHeader: env.IDENTITY_HEADER, identityHeaderRequired: true,
    copilotApiBaseUrl: env.COPILOT_API_BASE_URL, errorDiagnosticsEnabled: false, claudeCodeOptimized: true,
    requestStatsPerAccountLimit: 100 });
  const m = modules;
  const pool = await m.getUserPool();
  assert.ok(pool instanceof m.MysqlPoolStore);
  assert.ok(m.getStorage() instanceof m.MysqlStorage, 'HTTP credentials/statistics also use the real MySQL driver');
  const store = pool;
  for (let i = 0; i < 2; i++) {
    const member = await store.reserve();
    assert.ok(member);
    members.push(member.identity);
    tokens.set(`Bearer catalog-pressure-mysql-token-${i}`, member.identity);
    m.clearModelsCache(member.identity);
    await m.importCopilotOauthToken({ identity: member.identity, ssoUser: member.identity,
      ghLogin: 'catalog-pressure-mysql-synthetic', copilotOauthToken: `catalog-pressure-mysql-token-${i}` });
    await store.update(member.identity, { state: 'ready', stage: 'ready', verified_at: await store.now() });
  }
  // Instrument completion AFTER the real SQL commit. No queries or results are mocked.
  const originalFinish = store.finish;
  store.finish = async (held, success) => {
    await originalFinish.call(store, held, success);
    live.delete(held.request_id);
    for (const [id, context] of contexts) if (context.held.request_id === held.request_id) finished.add(id);
    events.emit('change');
  };
  restoreFinish = () => { store.finish = originalFinish; };
  const urls: string[] = [];
  for (let i = 0; i < 2; i++) {
    const app = m.express();
    app.use(m.express.json(), m.requireApiKey, m.requireIdentityHeader, m.routeUserPool);
    app.use((req, res, next) => {
      const context = m.poolRequest(res)!;
      const id = req.get('x-catalog-pressure-id')!;
      contexts.set(id, context);
      live.add(context.held.request_id);
      // Observe the actual per-request model-cache waiter subscription so cancel
      // ordering is deterministic even with asynchronous real SQL credential checks.
      const signal = context.controller.signal;
      const subscribe = signal.addEventListener.bind(signal);
      signal.addEventListener = (...args: Parameters<typeof signal.addEventListener>) => {
        subscribe(...args);
        if (args[0] === 'abort') { joined.add(id); events.emit('change'); }
      };
      events.emit('change');
      next();
    });
    app.use(m.compatibleRouter);
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    urls.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  }
  function request(caller: string, kind: 'GET' | 'HEAD' | 'count' | 'inference' = 'GET') {
    const id = String(++sequence);
    const method = kind === 'GET' || kind === 'HEAD' ? kind : 'POST';
    const path = kind === 'count' ? '/v1/messages/count_tokens' : kind === 'inference' ? '/v1/messages' : '/v1/models';
    const controller = new AbortController();
    controllers.push(controller);
    const response = realFetch(`${urls[sequence % urls.length]}${path}`, {
      method, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      headers: { Authorization: `Bearer ${env.API_KEY}`, 'X-User-Identity': caller,
        'Content-Type': 'application/json', 'x-catalog-pressure-id': id },
      body: method === 'POST' ? JSON.stringify({ model: 'claude-opus-5-2', max_tokens: 8,
        messages: [{ role: 'user', content: `catalog-pressure-mysql-request-${id}` }] }) : undefined,
    }).then(async response => ({ status: response.status, text: await response.text(), method }));
    const outcome = response.then(value => ({ value }), error => ({ error }));
    return { id, controller, response, outcome };
  }
  async function persistedHolds() {
    const [rows] = await admin!.query<RowDataPacket[]>({ sql: `SELECT h.request_id, l.caller_id, l.member_identity, 'lease' AS kind
      FROM \`${database}\`.user_pool_holds h JOIN \`${database}\`.user_pool_leases l ON l.lease_id=h.lease_id
      UNION ALL SELECT request_id, caller_id, member_identity, 'catalog' AS kind FROM \`${database}\`.user_pool_catalog_holds`, timeout: 3000 });
    const owners = new Map<string, string>();
    for (const row of rows) {
      assert.ok(!owners.has(row.member_identity) || owners.get(row.member_identity) === row.caller_id,
        'Real SQL never has overlapping callers on one member');
      owners.set(row.member_identity, row.caller_id);
    }
    return rows;
  }
  async function drain() {
    await until(() => live.size === 0, 'all SQL finish commits');
    assert.deepEqual(await persistedHolds(), []);
    assert.ok((await Promise.all(members.map(member => store.hasHolds(member)))).every(value => !value));
    assert.equal((await store.counts()).catalog_requests, 0);
    assert.ok((await store.leases()).every(lease => lease.active_requests === 0));
  }
  return { store, tokens, models, calls, contexts, joined, finished, request, until, persistedHolds, drain,
    releaseModels: () => models.forEach(call => call.release()),
    clearCache: () => members.forEach(m.clearModelsCache),
    releaseInference: () => { blockInference = false; inferenceGate.resolve(); },
  };
}

function success(result: WireResult) {
  assert.equal(result.status, 200, result.text);
  assert.ok(Buffer.byteLength(result.text) < 4096);
  if (result.method === 'HEAD') assert.equal(result.text, '');
  else assert.doesNotThrow(() => JSON.parse(result.text));
}

test('MySQL catalog HTTP pressure: shared refresh cancellation isolation, exclusive mixed inference, catalog TTL neutrality', options, async t => {
  const f = await fixture(t);
  const catalog = callers.slice(0, 2).flatMap(caller => Array.from({ length: 6 }, (_, i) =>
    f.request(caller, (['GET', 'HEAD', 'count'] as const)[i % 3])));
  await f.until(() => f.joined.size === 12, 'twelve SQL-backed catalog requests join cache');
  assert.equal(f.models.length, 2);
  assert.equal((await f.store.leases()).length, 0);
  assert.equal((await f.persistedHolds()).length, 12);
  const exhausted = await f.request(callers[2]).response;
  assert.equal(exhausted.status, 429);
  assert.equal(JSON.parse(exhausted.text).error.code, 'pool_exhausted');

  const inference = callers.slice(0, 2).flatMap(caller => Array.from({ length: 4 }, () => f.request(caller, 'inference')));
  await f.until(() => f.joined.size === 20, 'eight inference requests join existing catalog refreshes');
  assert.equal(f.models.length, 2);
  assert.equal((await f.persistedHolds()).length, 20);
  const leases = await f.store.leases();
  assert.equal(leases.length, 2);
  assert.notEqual(leases[0].member_identity, leases[1].member_identity);
  for (const caller of callers.slice(0, 2)) {
    const contexts = [...f.contexts.values()].filter(context => context.held.caller_id === caller);
    assert.equal(new Set(contexts.map(context => context.held.member_identity)).size, 1);
    assert.equal(contexts[0].held.member_identity, leases.find(lease => lease.caller_id === caller)!.member_identity);
  }
  catalog[0].controller.abort();
  assert.ok('error' in await catalog[0].outcome);
  await f.until(() => f.finished.has(catalog[0].id), 'cancelled catalog hold deletion commits');
  assert.equal((await f.persistedHolds()).length, 19);
  assert.ok(f.models.every(call => !call.signal.aborted && !call.cancelled), 'One cancel cannot abort surviving shared cache consumers');
  f.releaseModels();
  await f.until(() => f.calls.filter(call => call.path === '/v1/messages').length === 8, 'all mixed inference reaches upstream');
  for (const result of await Promise.all(catalog.slice(1).map(request => request.response))) success(result);
  await f.until(() => catalog.every(request => f.finished.has(request.id)), 'catalog finishes commit before inspecting inference leases');
  assert.ok((await f.store.leases()).every(lease => lease.phase === 'provisional'));
  assert.equal((await f.persistedHolds()).length, 8);
  f.releaseInference();
  for (const result of await Promise.all(inference.map(request => request.response))) success(result);
  await f.drain();
  const before = await f.store.leases();
  assert.ok(before.every(lease => lease.phase === 'active'));
  f.clearCache();
  const later = callers.slice(0, 2).flatMap(caller => (['GET', 'HEAD', 'count'] as const).map(kind => f.request(caller, kind)));
  await f.until(() => f.joined.size === 26, 'later catalog-only traffic joins cold refreshes');
  assert.equal(f.models.length, 4);
  f.releaseModels();
  for (const result of await Promise.all(later.map(request => request.response))) success(result);
  await f.drain();
  assert.deepEqual(await f.store.leases(), before, 'GET/HEAD/count do not renew expiry or last-success SQL timestamps');
  for (const call of f.calls.filter(call => call.path === '/v1/messages')) {
    const id = JSON.stringify(call.body?.messages).match(/catalog-pressure-mysql-request-(\d+)/)?.[1];
    assert.ok(id);
    assert.equal(f.tokens.get(call.token), f.contexts.get(id)!.held.member_identity);
    assert.equal(call.body?.model, model.id);
  }
});

test('MySQL catalog HTTP pressure: all partial-body waiters cancel, SQL holds drain, new caller refresh succeeds', options, async t => {
  const f = await fixture(t);
  const requests = Array.from({ length: 9 }, (_, i) => f.request(callers[0], (['GET', 'HEAD', 'count'] as const)[i % 3]));
  await f.until(() => f.joined.size === 9 && f.models[0]?.bytes > 0, 'nine real SQL admissions join partial body');
  assert.equal(f.models.length, 1);
  assert.equal((await f.persistedHolds()).length, 9);
  assert.equal((await f.store.leases()).length, 0);
  requests.forEach(request => request.controller.abort());
  for (const outcome of await Promise.all(requests.map(request => request.outcome))) assert.ok('error' in outcome);
  await f.until(() => f.models[0].cancelled, 'last cache consumer cancels partial upstream reader');
  assert.equal(f.models[0].signal.aborted, true);
  await f.drain();
  assert.equal((await f.store.leases()).length, 0);
  assert.equal((await f.store.counts()).ready_idle, 2);
  const retry = f.request(callers[1]);
  await f.until(() => f.joined.has(retry.id) && f.models.length === 2, 'new caller starts fresh, uncancelled refresh');
  assert.equal(f.models[1].signal.aborted, false);
  f.releaseModels();
  success(await retry.response);
  await f.drain();
  assert.equal((await f.store.leases()).length, 0);
  assert.equal((await f.store.counts()).ready_idle, 2);
});
