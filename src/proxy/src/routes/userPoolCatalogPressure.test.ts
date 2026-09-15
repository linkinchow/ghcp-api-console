import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test, type TestContext } from 'node:test';
import type { PoolRequest } from '../userPool/runtime.js';
import type { HeldLease, UserPoolStore } from '../userPool/store.js';

// Intentionally one process: two real Express listeners share real SQLite storage
// and the production process-local model cache. This is NOT a MySQL/replica test.
// Import application modules only after preventing dotenv from reading real secrets.
const safeEnv = {
  DOTENV_CONFIG_PATH: join(tmpdir(), `catalog-pressure-no-dotenv-${randomUUID()}.env`),
  ACCOUNT_ROUTING_MODE: 'caller-lease', STORAGE_DRIVER: 'sqlite', DB_PATH: ':memory:',
  MYSQL_URL: '', MYSQL_SSL_MODE: 'disabled', MYSQL_SSL_CA_PATH: '',
  API_KEY: 'catalog-pressure-synthetic-key', INTERNAL_API_TOKEN: 'catalog-pressure-internal',
  IDENTITY_HEADER: 'X-User-Identity', IDENTITY_HEADER_REQUIRED: 'true', CLAUDE_CODE_OPTIMIZED: 'true',
  COPILOT_API_BASE_URL: 'http://127.0.0.1:1/catalog-pressure-upstream',
  SSO_BASE_URL: 'http://127.0.0.1:1', LOGIN_BASE_URL: 'http://127.0.0.1:1',
  PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false',
  POOL_ACCOUNT_EMAIL_DOMAIN: 'catalog-pressure.test', POOL_WARMUP_MODEL: 'claude-opus-5-2',
  READY_IDLE_TARGET: '2', POOL_MAX_ACCOUNTS: '2', POOL_REQUEST_TIMEOUT_SECONDS: '5',
  CALLER_LEASE_TTL_SECONDS: '120', PROVISIONAL_LEASE_TTL_SECONDS: '30',
  PREWARM_POLL_SECONDS: '1', PREWARM_CONCURRENCY: '1', POOL_LOGIN_MAX_PENDING: '1',
  POOL_EXHAUSTED_RETRY_AFTER_SECONDS: '1',
};
const savedEnv = Object.fromEntries(Object.keys(safeEnv).map(key => [key, process.env[key]]));
const realFetch = globalThis.fetch;
let modules: Awaited<ReturnType<typeof loadModules>>;
let savedConfig: typeof modules.config;

async function loadModules() {
  const [express, configuration, connection, accounts, client, runtime, store, auth, identity, routes] = await Promise.all([
    import('express'), import('../config.js'), import('../db/connection.js'), import('../db/accountsRepo.js'),
    import('../copilot/copilotClient.js'), import('../userPool/runtime.js'), import('../userPool/store.js'),
    import('../auth/apiKey.js'), import('../auth/identityHeader.js'), import('./compatible.js'),
  ]);
  return { express: express.default, ...configuration, ...connection, ...accounts, ...client, ...runtime,
    ...store, ...auth, ...identity, ...routes };
}

before(async () => {
  Object.assign(process.env, safeEnv);
  modules = await loadModules();
  savedConfig = { ...modules.config };
  Object.assign(modules.config, { storageDriver: 'sqlite', dbPath: ':memory:', apiKey: safeEnv.API_KEY,
    copilotApiBaseUrl: safeEnv.COPILOT_API_BASE_URL, errorDiagnosticsEnabled: false, claudeCodeOptimized: true,
    requestStatsPerAccountLimit: 100 });
});
after(() => {
  globalThis.fetch = realFetch;
  if (modules && savedConfig) Object.assign(modules.config, savedConfig);
  for (const key of Object.keys(safeEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const callers = ['a', 'b', 'c'].map(hex => `sha256:${hex.repeat(64)}`);
const model = { id: 'claude-opus-5.2', capabilities: { endpoints: ['/v1/messages', '/chat/completions', '/responses'] } };
const encoder = new TextEncoder();
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}

type ModelMode = 'partial' | 'oversized';
type UpstreamCall = { token: string; path: string; signal: AbortSignal; body?: Record<string, unknown> };
type ModelCall = UpstreamCall & { release: () => void; cancelled: boolean; emitted: number };
type RequestResult = { status: number; text: string; bytes: number; method: string };

async function fixture(t: TestContext) {
  const { config, getUserPool, UserPoolStore, importCopilotOauthToken, clearModelsCache } = modules;
  const pool = await getUserPool();
  assert.ok(pool instanceof UserPoolStore);
  const store: UserPoolStore = pool;
  let now = store.now();
  store.now = () => now;
  const members: string[] = [];
  const tokens = new Map<string, string>();
  const servers: Server[] = [];
  const controllers: AbortController[] = [];
  const events = new EventEmitter();
  const admitted = new Map<string, PoolRequest>();
  const waiters = new Set<string>();
  const finished = new Set<string>();
  const live = new Map<string, HeldLease>();
  const overlap: string[] = [];
  const calls: UpstreamCall[] = [];
  const models: ModelCall[] = [];
  const inferenceGate = deferred();
  let holdInference = false;
  let modelMode: ModelMode = 'partial';
  let nextId = 0;
  let originalFinish: typeof store.finish | undefined;

  // All helpers use event barriers plus hard safety deadlines, never timing sleeps.
  async function until(predicate: () => boolean, label: string, timeout = 3000) {
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (predicate()) { cleanup(); resolve(); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Barrier timed out: ${label}`)); }, timeout);
      const cleanup = () => { clearTimeout(timer); events.off('change', check); };
      events.on('change', check);
      check();
    });
  }
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    for (const call of models) call.release();
    inferenceGate.resolve();
    for (const server of servers) server.closeAllConnections();
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    try { await until(() => live.size === 0, 'cleanup holds drain'); }
    finally {
      if (originalFinish) store.finish = originalFinish;
      globalThis.fetch = realFetch;
      for (const member of members) clearModelsCache(member);
      await modules.stopUserPool();
      await modules.closeStorage();
    }
  });

  for (let i = 0; i < 2; i++) {
    const member = store.reserve()!;
    members.push(member.identity);
    tokens.set(`Bearer catalog-pressure-token-${i}`, member.identity);
    clearModelsCache(member.identity);
    await importCopilotOauthToken({ identity: member.identity, ssoUser: member.identity,
      ghLogin: 'catalog-pressure-synthetic', copilotOauthToken: `catalog-pressure-token-${i}` });
    store.update(member.identity, { state: 'ready', stage: 'ready', verified_at: now });
  }
  // Observe, do not replace, real SQLite admission/finish semantics.
  originalFinish = store.finish;
  store.finish = (held, success) => {
    originalFinish!.call(store, held, success);
    live.delete(held.request_id);
    for (const [id, context] of admitted) if (context.held.request_id === held.request_id) finished.add(id);
    events.emit('change');
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'http://127.0.0.1:1', 'No unmocked or real upstream is permitted');
    assert.ok(url.pathname.startsWith('/catalog-pressure-upstream/'));
    const path = url.pathname.slice('/catalog-pressure-upstream'.length);
    assert.ok(['/models', '/v1/messages', '/v1/messages/count_tokens'].includes(path), `Unexpected upstream ${path}`);
    const token = new Headers(init?.headers).get('authorization') ?? '';
    assert.ok(tokens.has(token), 'Only fixture credentials may be forwarded');
    assert.ok(init?.signal);
    const call: UpstreamCall = { token, path, signal: init.signal,
      body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined };
    calls.push(call);
    if (path === '/models') {
      const gate = deferred();
      const current: ModelCall = { ...call, release: gate.resolve, cancelled: false, emitted: 0 };
      models.push(current);
      const mode = modelMode;
      let first = true;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (first) {
            first = false;
            const prefix = encoder.encode('{"data":[');
            current.emitted += prefix.byteLength;
            controller.enqueue(prefix);
            events.emit('change');
            return;
          }
          await gate.promise;
          if (current.cancelled) return;
          if (mode === 'oversized') {
            const chunk = new Uint8Array(64 * 1024).fill(32);
            current.emitted += chunk.byteLength;
            controller.enqueue(chunk);
          } else {
            const suffix = encoder.encode(`${JSON.stringify(model)}]}`);
            current.emitted += suffix.byteLength;
            controller.enqueue(suffix);
            controller.close();
          }
        },
        cancel() { current.cancelled = true; gate.resolve(); events.emit('change'); },
      }, { highWaterMark: 0 });
      events.emit('change');
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    }
    events.emit('change');
    if (path === '/v1/messages/count_tokens') return json({ input_tokens: 7 });
    if (holdInference) await inferenceGate.promise;
    call.signal.throwIfAborted();
    return json({ id: 'catalog-pressure-result', model: model.id, content: [{ type: 'text', text: 'OK' }] });
  };

  const urls: string[] = [];
  for (let i = 0; i < 2; i++) {
    const app = modules.express();
    app.use(modules.express.json(), modules.requireApiKey, modules.requireIdentityHeader, modules.routeUserPool);
    app.use((req, res, next) => {
      const context = modules.poolRequest(res)!;
      const id = req.get('x-catalog-pressure-id')!;
      admitted.set(id, context);
      for (const held of live.values()) {
        if (held.member_identity === context.held.member_identity && held.caller_id !== context.held.caller_id) {
          overlap.push(`${held.caller_id} overlapped ${context.held.caller_id}`);
        }
      }
      live.set(context.held.request_id, context.held);
      // The first abort subscription on this per-request signal is the actual
      // model-cache waiter. Observing it gives an exact joined-refresh barrier;
      // neither the cache nor its cancellation implementation is mocked.
      const signal = context.controller.signal;
      const subscribe = signal.addEventListener.bind(signal);
      signal.addEventListener = (...args: Parameters<typeof signal.addEventListener>) => {
        subscribe(...args);
        if (args[0] === 'abort') { waiters.add(id); events.emit('change'); }
      };
      events.emit('change');
      next();
    });
    app.use(modules.compatibleRouter);
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    urls.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  }

  function request(caller: string, kind: 'GET' | 'HEAD' | 'count' | 'inference' = 'GET') {
    const id = String(++nextId);
    const method = kind === 'GET' || kind === 'HEAD' ? kind : 'POST';
    const path = kind === 'count' ? '/v1/messages/count_tokens' : kind === 'inference' ? '/v1/messages' : '/v1/models';
    const controller = new AbortController();
    controllers.push(controller);
    const response = realFetch(`${urls[nextId % urls.length]}${path}`, {
      method, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      headers: { Authorization: `Bearer ${config.apiKey}`, 'X-User-Identity': caller,
        'Content-Type': 'application/json', 'x-catalog-pressure-id': id },
      body: method === 'POST' ? JSON.stringify({ model: 'claude-opus-5-2', max_tokens: 8,
        messages: [{ role: 'user', content: `catalog-pressure-request-${id}` }] }) : undefined,
    }).then(async response => {
      const text = await response.text();
      return { status: response.status, text, bytes: Buffer.byteLength(text), method };
    });
    // Register the rejection handler now; aborting several requests must not create
    // transient unhandled rejections before the assertions consume their promises.
    const outcome = response.then(value => ({ value }), error => ({ error }));
    return { id, controller, response, outcome };
  }
  async function drain() {
    await until(() => live.size === 0, 'all persisted holds finish');
    assert.ok(members.every(member => !store.hasHolds(member)));
    assert.equal(store.counts().catalog_requests, 0);
    assert.ok(store.leases().every(lease => lease.active_requests === 0));
    assert.deepEqual(overlap, [], 'Different callers never share a live member');
  }
  return { store, members, tokens, models, calls, admitted, waiters, finished, request, until, drain,
    advance: (ms: number) => { now += ms; },
    mode: (value: ModelMode) => { modelMode = value; },
    holdInference: () => { holdInference = true; }, releaseInference: inferenceGate.resolve,
    clearCache: () => members.forEach(clearModelsCache),
    releaseModels: () => models.forEach(call => call.release()),
  };
}

function success(result: RequestResult) {
  assert.equal(result.status, 200, result.text);
  assert.ok(result.bytes < 4096, 'Synthetic response stays bounded');
  if (result.method === 'HEAD') assert.equal(result.text, '');
  else assert.doesNotThrow(() => JSON.parse(result.text));
}

const options = { timeout: 15_000, concurrency: false };

test('catalog pressure: GET/HEAD/count share refreshes, isolate callers and survive one cancelled waiter', options, async t => {
  const f = await fixture(t);
  const requests = callers.slice(0, 2).flatMap(caller => Array.from({ length: 12 }, (_, i) =>
    f.request(caller, (['GET', 'HEAD', 'count'] as const)[i % 3])));
  await f.until(() => f.waiters.size === requests.length, '24 catalog waiters joined');
  assert.equal(f.models.length, 2, 'Exactly one cold refresh per exclusive member across both listeners');
  assert.equal(f.store.counts().catalog_requests, 24);
  assert.equal(f.store.leases().length, 0, 'Catalog-only callers never allocate leases');
  assert.equal(f.store.counts().ready_idle, 0);
  for (const caller of callers.slice(0, 2)) {
    assert.equal(new Set([...f.admitted.values()].filter(c => c.held.caller_id === caller).map(c => c.held.member_identity)).size, 1);
  }
  const exhausted = await f.request(callers[2]).response;
  assert.equal(exhausted.status, 429);
  assert.equal(JSON.parse(exhausted.text).error.code, 'pool_exhausted');
  assert.equal(f.models.length, 2);
  requests[0].controller.abort();
  assert.ok('error' in await requests[0].outcome);
  await f.until(() => f.finished.has(requests[0].id), 'cancelled waiter releases its catalog hold');
  assert.equal(f.store.counts().catalog_requests, 23);
  assert.ok(f.models.every(call => !call.signal.aborted && !call.cancelled), 'One waiter must not abort either shared refresh');
  f.releaseModels();
  for (const result of await Promise.all(requests.slice(1).map(request => request.response))) success(result);
  await f.drain();
  assert.equal(f.store.leases().length, 0);
  assert.equal(f.calls.filter(call => call.path === '/v1/messages/count_tokens').length, 8);
  assert.equal(f.calls.filter(call => call.path === '/v1/messages').length, 0);
});

test('catalog pressure: same-caller inference converges and later catalog traffic does not renew lease TTL', options, async t => {
  const f = await fixture(t);
  f.holdInference();
  const catalog = callers.slice(0, 2).flatMap(caller => (['GET', 'HEAD', 'count'] as const).map(kind => f.request(caller, kind)));
  await f.until(() => f.waiters.size === 6, 'catalogs pin both members before inference');
  const inference = callers.slice(0, 2).flatMap(caller => Array.from({ length: 4 }, () => f.request(caller, 'inference')));
  await f.until(() => f.waiters.size === 14, 'inference joins existing catalog refreshes');
  assert.equal(f.models.length, 2);
  assert.equal(f.store.leases().length, 2);
  for (const caller of callers.slice(0, 2)) {
    const contexts = [...f.admitted.values()].filter(context => context.held.caller_id === caller);
    assert.equal(new Set(contexts.map(context => context.held.member_identity)).size, 1);
    const lease = f.store.leases().find(lease => lease.caller_id === caller)!;
    assert.equal(lease.member_identity, contexts[0].held.member_identity);
    assert.equal(lease.phase, 'provisional');
  }
  f.releaseModels();
  await f.until(() => f.calls.filter(call => call.path === '/v1/messages').length === 8, 'all inference calls are simultaneously upstream');
  for (const result of await Promise.all(catalog.map(request => request.response))) success(result);
  assert.ok(f.store.leases().every(lease => lease.phase === 'provisional'), 'Successful catalog/count requests do not promote inference leases');
  f.releaseInference();
  for (const result of await Promise.all(inference.map(request => request.response))) success(result);
  await f.drain();
  assert.ok(f.store.leases().every(lease => lease.phase === 'active'));
  const before = f.store.leases();
  f.advance(1000);
  f.clearCache();
  const later = callers.slice(0, 2).flatMap(caller => (['GET', 'HEAD', 'count'] as const).map(kind => f.request(caller, kind)));
  await f.until(() => f.waiters.size === 20, 'later catalogs all join refreshed cache');
  assert.equal(f.models.length, 4);
  f.releaseModels();
  for (const result of await Promise.all(later.map(request => request.response))) success(result);
  await f.drain();
  assert.deepEqual(f.store.leases(), before, 'Catalog GET, HEAD and token counts change neither expiry nor last success');
  const expectedForwards = new Map(inference.map(request => {
    const held = f.admitted.get(request.id)!.held;
    return [request.id, held.member_identity];
  }));
  for (const call of f.calls.filter(call => call.path !== '/models')) {
    assert.equal(call.body?.model, model.id, 'Inference and count use resolved upstream model IDs');
    if (call.path === '/v1/messages') {
      const messages = call.body!.messages as Array<{ content: unknown }>;
      const requestId = JSON.stringify(messages).match(/catalog-pressure-request-(\d+)/)?.[1];
      assert.ok(requestId);
      assert.equal(f.tokens.get(call.token), expectedForwards.get(requestId), 'Actual upstream credential belongs to the admitted exclusive member');
    }
  }
});

test('catalog pressure: all cancelled waiters abort a partial body, drain holds and permit a fresh refresh', options, async t => {
  const f = await fixture(t);
  const requests = Array.from({ length: 9 }, (_, i) => f.request(callers[0], (['GET', 'HEAD', 'count'] as const)[i % 3]));
  await f.until(() => f.waiters.size === 9 && f.models[0]?.emitted > 0, 'all waiters joined partial model body');
  assert.equal(f.models.length, 1);
  requests.forEach(request => request.controller.abort());
  for (const outcome of await Promise.all(requests.map(request => request.outcome))) assert.ok('error' in outcome);
  await f.until(() => f.models[0].cancelled, 'shared body reader cancelled after its last waiter leaves');
  assert.equal(f.models[0].signal.aborted, true);
  await f.drain();
  assert.equal(f.store.leases().length, 0);
  const retry = f.request(callers[0]);
  await f.until(() => f.waiters.has(retry.id) && f.models.length === 2, 'retry starts a new refresh, not the detached cancelled one');
  assert.equal(f.models[1].signal.aborted, false);
  f.releaseModels();
  success(await retry.response);
  await f.drain();
  assert.equal(f.store.leases().length, 0);
});

test('catalog pressure: oversized partial model response fails all waiters within the 8 MiB body bound', options, async t => {
  const f = await fixture(t);
  f.mode('oversized');
  const requests = [f.request(callers[0]), f.request(callers[0], 'HEAD'), f.request(callers[0], 'count')];
  await f.until(() => f.waiters.size === 3, 'all byte-bound waiters joined');
  const started = performance.now();
  f.releaseModels();
  for (const result of await Promise.all(requests.map(request => request.response))) {
    assert.equal(result.status, 502, result.text);
    assert.ok(result.bytes < 1024);
    if (result.method !== 'HEAD') assert.match(result.text, /8 MiB/);
  }
  assert.ok(performance.now() - started < 3000, 'Oversized input fails without waiting for request timeout');
  assert.equal(f.models.length, 1);
  assert.equal(f.models[0].cancelled, true);
  assert.ok(f.models[0].emitted > 8 * 1024 * 1024);
  assert.ok(f.models[0].emitted <= 8 * 1024 * 1024 + 64 * 1024, 'At most the crossing chunk is consumed');
  await f.drain();
  assert.equal(f.store.leases().length, 0);
  f.mode('partial');
  const retry = f.request(callers[0]);
  await f.until(() => f.models.length === 2, 'oversized result was not cached');
  f.releaseModels();
  success(await retry.response);
  await f.drain();
});

test('catalog pressure: stalled shared partial body hits HTTP request deadlines and drains every hold', options, async t => {
  const f = await fixture(t);
  const started = performance.now();
  const requests = [f.request(callers[0]), f.request(callers[0], 'HEAD'), f.request(callers[0], 'count')];
  await f.until(() => f.waiters.size === 3 && f.models[0]?.emitted > 0, 'deadline waiters joined partial body');
  for (const result of await Promise.all(requests.map(request => request.response))) {
    assert.equal(result.status, 504, result.text);
    assert.ok(result.bytes < 1024);
    if (result.method !== 'HEAD') assert.equal(JSON.parse(result.text).error.code, 'pool_request_timeout');
  }
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 4500 && elapsed < 8500, `Five-second route deadline bounded elapsed ${elapsed}ms`);
  await f.until(() => f.models[0].cancelled, 'last timed-out waiter cancels shared reader');
  assert.equal(f.models[0].signal.aborted, true);
  assert.equal(f.models.length, 1);
  await f.drain();
  assert.equal(f.store.leases().length, 0);
});
