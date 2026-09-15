import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { config } from '../config.js';
import { getStorage, closeStorage } from '../db/connection.js';
import { importCopilotOauthToken } from '../db/accountsRepo.js';
import { buildApp, startServer } from '../server.js';
import { getUserPool, stopUserPool } from '../userPool/runtime.js';
import { UserPoolStore } from '../userPool/store.js';
import { clearModelsCache } from '../copilot/copilotClient.js';

const originalFetch = globalThis.fetch;
const caller = `sha256:${'a'.repeat(64)}`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const keys = ['ACCOUNT_ROUTING_MODE', 'POOL_ACCOUNT_EMAIL_DOMAIN', 'POOL_WARMUP_MODEL', 'READY_IDLE_TARGET',
    'POOL_MAX_ACCOUNTS', 'POOL_REQUEST_TIMEOUT_SECONDS', 'STORAGE_DRIVER'];
  const savedEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const savedConfig = { ...config };
  Object.assign(process.env, { ACCOUNT_ROUTING_MODE: 'caller-lease', POOL_ACCOUNT_EMAIL_DOMAIN: 'synthetic.test',
    POOL_WARMUP_MODEL: 'test-model', READY_IDLE_TARGET: '1', POOL_MAX_ACCOUNTS: '2',
    POOL_REQUEST_TIMEOUT_SECONDS: '5', STORAGE_DRIVER: 'sqlite' });
  Object.assign(config, { apiKey: 'synthetic-review-key', storageDriver: 'sqlite', dbPath: ':memory:', requestStatsPerAccountLimit: 100 });
  const store = await getUserPool();
  assert.ok(store instanceof UserPoolStore);
  let now = store.now(); store.now = () => now;
  const member = store.reserve()!;
  clearModelsCache(member.identity);
  await importCopilotOauthToken({ identity: member.identity, ssoUser: member.identity, ghLogin: 'synthetic', copilotOauthToken: 'synthetic-token' });
  store.update(member.identity, { state: 'ready', stage: 'ready', verified_at: now });
  let forwarded = 0;
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    assert.ok(['/models', '/v1/messages'].includes(path));
    if (path !== '/models') forwarded++;
    return new Response(JSON.stringify(path === '/models'
      ? { data: [{ id: 'claude-opus-5.2', capabilities: { endpoints: ['/v1/messages'] } }] }
      : { id: 'synthetic', model: 'claude-opus-5.2', content: [{ type: 'text', text: 'OK' }] }),
    { headers: { 'Content-Type': 'application/json' } });
  };
  const server = buildApp().listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    store, member, forwarded: () => forwarded, advance: () => { now += 6000; },
    request: (signal?: AbortSignal, catalog = false) => originalFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${catalog ? '/v1/models' : '/v1/messages'}`, {
      method: catalog ? 'GET' : 'POST', signal, headers: { Authorization: 'Bearer synthetic-review-key', 'Content-Type': 'application/json', 'X-User-Identity': caller },
      body: catalog ? undefined : JSON.stringify({ model: 'claude-opus-5-2', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
    }),
    async close() {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      globalThis.fetch = originalFetch; clearModelsCache(member.identity);
      await stopUserPool(); await closeStorage(); Object.assign(config, savedConfig);
      for (const key of keys) {
        if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
      }
    },
  };
}

test('completed inference promotes and drains before unrelated statistics settle', async () => {
  const f = await fixture(); const storage = getStorage(); const saved = storage.recordRequestStat;
  const delayed = deferred(); storage.recordRequestStat = async () => delayed.promise;
  try {
    const response = await f.request(); assert.equal(response.status, 200); await response.text();
    for (let i = 0; i < 100 && f.store.hasHolds(f.member.identity); i++) await sleep(10);
    assert.equal(f.store.hasHolds(f.member.identity), false);
    assert.equal(f.store.leases()[0].phase, 'active');
    f.advance(); delayed.resolve(); await sleep(30);
    assert.equal(f.store.leases()[0].phase, 'active');
  } finally { delayed.resolve(); await sleep(30); storage.recordRequestStat = saved; await f.close(); }
});

test('disconnect stops heartbeat during delayed account lookup and forbids late forwarding', async () => {
  const f = await fixture(); const storage = getStorage(); const saved = storage.getAccount;
  const started = deferred(), delayed = deferred();
  storage.getAccount = async identity => { started.resolve(); await delayed.promise; return saved.call(storage, identity); };
  let beats = 0; const heartbeat = f.store.heartbeat.bind(f.store);
  f.store.heartbeat = held => { beats++; return heartbeat(held); };
  const abort = new AbortController(); const pending = f.request(abort.signal).catch(() => undefined);
  try {
    await started.promise; abort.abort(); await pending; await sleep(100); const atDisconnect = beats;
    await sleep(5200);
    assert.equal(beats, atDisconnect);
    assert.equal(f.store.hasHolds(f.member.identity), true, 'Keep drain fence until the active operation settles');
    delayed.resolve();
    for (let i = 0; i < 100 && f.store.hasHolds(f.member.identity); i++) await sleep(10);
    assert.equal(f.store.hasHolds(f.member.identity), false);
    assert.equal(f.forwarded(), 0);
  } finally { delayed.resolve(); await sleep(30); storage.getAccount = saved; await f.close(); }
});

test('runtime passes a disconnectable admission signal to inference and catalog stores', async () => {
  const f = await fixture();
  const storage = getStorage();
  const saved = storage.userPool;
  let started = deferred();
  const signals: AbortSignal[] = [];
  // Reset runtime's cache and return a remote-store-shaped wrapper without changing
  // SQLite's synchronous return types or admitting any persisted hold.
  await stopUserPool();
  const remote = new Proxy(f.store, {
    get(target, property, receiver) {
      if (property === 'acquire' || property === 'acquireCatalog') {
        return (_caller: string, signal?: AbortSignal) => {
          assert.ok(signal instanceof AbortSignal);
          signals.push(signal);
          started.resolve();
          return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  storage.userPool = () => remote;
  let abort = new AbortController();
  try {
    for (const catalog of [false, true]) {
      started = deferred();
      abort = new AbortController();
      const pending = f.request(abort.signal, catalog).catch(() => undefined);
      await started.promise;
      const signal = signals.at(-1)!;
      assert.equal(signal.aborted, false);
      abort.abort();
      await pending;
      for (let i = 0; i < 100 && !signal.aborted; i++) await sleep(10);
      assert.equal(signal.aborted, true);
      assert.equal(f.store.hasHolds(f.member.identity), false);
      assert.equal(f.forwarded(), 0);
    }
    assert.equal(signals.length, 2);
    assert.notEqual(signals[0], signals[1]);
  } finally { abort.abort(); storage.userPool = saved; await f.close(); }
});

test('pool configuration rejection happens before shared retention pruning', async () => {
  const savedConfig = { ...config };
  const keys = ['ACCOUNT_ROUTING_MODE', 'STORAGE_DRIVER', 'POOL_ACCOUNT_EMAIL_DOMAIN', 'POOL_WARMUP_MODEL'];
  const savedEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(config, { storageDriver: 'sqlite', dbPath: ':memory:', apiKey: 'synthetic', internalApiToken: 'synthetic' });
  Object.assign(process.env, { ACCOUNT_ROUTING_MODE: 'caller-lease', STORAGE_DRIVER: 'sqlite',
    POOL_ACCOUNT_EMAIL_DOMAIN: 'synthetic.test', POOL_WARMUP_MODEL: 'unused' });
  const storage = getStorage(); let pruned = false;
  storage.userPool = () => { throw new Error('Pool configuration differs'); };
  storage.pruneAllRequestStats = async () => { pruned = true; };
  try { await assert.rejects(startServer(), /Pool configuration differs/); assert.equal(pruned, false); }
  finally {
    await stopUserPool(); await closeStorage(); Object.assign(config, savedConfig);
    for (const key of keys) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
  }
});
