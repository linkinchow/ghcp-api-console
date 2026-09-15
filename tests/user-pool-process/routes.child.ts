import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiKey, bounded, createdAt, internalKey, loopbackOrigin, model, mysqlGate, tokenA, tokenB } from './routes.safety.js';

// Every guard precedes dotenv-bearing imports, listeners and MySQL initialization.
const db = mysqlGate(process.env);
assert.equal(process.env.ROUTES_CHILD, '1');
assert.ok(process.send && process.connected, 'Fixture child requires its parent IPC channel');
assert.match(db.pathname, /^\/ghcp_pool_test_[a-f0-9]{32}$/);
const mockOrigin = loopbackOrigin(process.env.ROUTES_MOCK_ORIGIN!);
const controlKey = process.env.ROUTES_CONTROL_KEY!;
assert.match(controlKey, /^[a-f0-9]{64}$/);
const instance = randomUUID();
const dotenvPath = join(tmpdir(), `process-routes-missing-${randomUUID()}`, '.env');
assert.equal(existsSync(dotenvPath), false);
// Do not inherit product configuration, credentials, proxy settings or Node hooks.
for (const key of Object.keys(process.env)) {
  if (!['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'Path'].includes(key)) delete process.env[key];
}
Object.assign(process.env, {
  TSX_TSCONFIG_PATH: fileURLToPath(new URL('./tsconfig.routes.json', import.meta.url)),
  DOTENV_CONFIG_PATH: dotenvPath, NODE_ENV: 'test', STORAGE_DRIVER: 'mysql', MYSQL_URL: db.toString(),
  MYSQL_CONNECTION_LIMIT: '6', MYSQL_SSL_MODE: 'disabled', MYSQL_SSL_CA_PATH: '', DB_PATH: ':memory:', PORT: '3000',
  ACCOUNT_ROUTING_MODE: 'caller-lease', API_KEY: apiKey, INTERNAL_API_TOKEN: internalKey,
  IDENTITY_HEADER: 'X-User-Identity', IDENTITY_HEADER_REQUIRED: 'true', CLAUDE_CODE_OPTIMIZED: 'false',
  COPILOT_API_BASE_URL: mockOrigin, SSO_BASE_URL: mockOrigin, LOGIN_BASE_URL: mockOrigin,
  PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false', PROXY_INSTANCE_ID: instance, REQUEST_STATS_PER_ACCOUNT_LIMIT: '100',
  POOL_ACCOUNT_EMAIL_DOMAIN: 'process-routes.test', POOL_WARMUP_MODEL: model, READY_IDLE_TARGET: '1', POOL_MAX_ACCOUNTS: '1',
  POOL_REQUEST_TIMEOUT_SECONDS: '25', CALLER_LEASE_TTL_SECONDS: '600', PROVISIONAL_LEASE_TTL_SECONDS: '300',
  PREWARM_POLL_SECONDS: '60', PREWARM_CONCURRENCY: '1', POOL_LOGIN_MAX_PENDING: '1', POOL_EXHAUSTED_RETRY_AFTER_SECONDS: '1',
});
assert.equal(import.meta.resolve('@ghcp/shared'), new URL('../../src/packages/shared/src/index.ts', import.meta.url).href,
  'Use this checkout shared source, never an ancestor workspace dist');

// Installed before imports/storage/startup: IPC loss and the lifetime ceiling also
// bound hung initialization. Cleanup attempts every registered step, even on failure.
const servers: Server[] = [];
const cleanupSteps: Array<() => Promise<void>> = [];
let closing = false;
const lifetime = setTimeout(() => { void shutdown(1); }, 110000);
async function shutdown(exitCode = 0) {
  if (closing) return; closing = true;
  clearTimeout(lifetime);
  const force = setTimeout(() => process.exit(1), 5000);
  try {
    for (const server of servers) { server.closeAllConnections(); server.close(); }
    for (const step of cleanupSteps) {
      try { await step(); } catch { exitCode = 1; }
    }
  } finally { clearTimeout(force); process.exit(exitCode); }
}
process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown') void shutdown(); });
process.once('disconnect', () => { void shutdown(1); });
process.once('SIGTERM', () => { void shutdown(); });

const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(target.origin, mockOrigin, 'No non-fixture upstream is permitted');
  assert.equal(target.search + target.hash, '');
  const sso = /^\/api\/users\/[a-z]+\.[a-z]+[0-9]{2}$/.test(target.pathname);
  assert.ok(['/models', '/v1/messages'].includes(target.pathname) || sso);
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  assert.equal(method, target.pathname === '/v1/messages' ? 'POST' : 'GET');
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (sso) assert.equal(headers.get('x-internal-token'), internalKey);
  else assert.ok([`Bearer ${tokenA}`, `Bearer ${tokenB}`].includes(headers.get('authorization') ?? ''));
  headers.set('x-process-routes-pid', String(process.pid));
  return nativeFetch(input, { ...init, headers, redirect: 'error' });
};
const [expressModule, runtime, storage, accounts, client, provisioner, workerModule, poolConfig, auth, identity, routes, mysqlStore, mysqlStorage] = await Promise.all([
  import('express'), import('../../src/proxy/src/userPool/runtime.js'), import('../../src/proxy/src/db/connection.js'),
  import('../../src/proxy/src/db/accountsRepo.js'), import('../../src/proxy/src/copilot/copilotClient.js'),
  import('../../src/proxy/src/userPool/provisioner.js'), import('../../src/proxy/src/userPool/worker.js'),
  import('../../src/proxy/src/userPool/config.js'), import('../../src/proxy/src/auth/apiKey.js'),
  import('../../src/proxy/src/auth/identityHeader.js'), import('../../src/proxy/src/routes/compatible.js'),
  import('../../src/proxy/src/userPool/mysqlStore.js'), import('../../src/proxy/src/db/mysqlStorage.js'),
]);
cleanupSteps.push(() => runtime.stopUserPool(), () => storage.closeStorage());
const store = await runtime.getUserPool();
assert.ok(store instanceof mysqlStore.MysqlPoolStore);
assert.ok(storage.getStorage() instanceof mysqlStorage.MysqlStorage);
const options = poolConfig.readPoolConfig(process.env);
const worker = new workerModule.PrewarmWorker(store, provisioner.realProvisioner(store, options), 60000, 1, undefined, { multiReplica: true });
cleanupSteps.unshift(() => worker.stop());
const contexts = new Map<string, { requestId: string; joined: boolean; member: string }>();
const express = expressModule.default;
const app = express();
app.use(express.json(), auth.requireApiKey, identity.requireIdentityHeader, runtime.routeUserPool);
app.use((req, res, next) => {
  const context = runtime.poolRequest(res);
  const id = req.get('x-process-routes-id');
  if (context && id) {
    assert.match(id, /^r[0-9]+$/);
    const observation = { requestId: context.held.request_id, joined: false, member: context.held.member_identity };
    contexts.set(id, observation);
    // Observer only, identical subscription semantics; enables a deterministic cache-join barrier.
    const signal = context.controller.signal;
    const subscribe = signal.addEventListener.bind(signal);
    signal.addEventListener = (...args: Parameters<typeof signal.addEventListener>) => {
      subscribe(...args);
      if (args[0] === 'abort') observation.joined = true;
    };
  }
  next();
});
app.use(routes.compatibleRouter);
const proxy = app.listen(0, '127.0.0.1'); servers.push(proxy);
await bounded(once(proxy, 'listening'), 'proxy listen');
let member: string | undefined;
let seeded = false;
const control = createServer(async (req, res) => {
  if (closing || req.socket.remoteAddress !== '127.0.0.1' || req.headers.authorization !== `Bearer ${controlKey}`) {
    res.writeHead(403).end('Forbidden'); return;
  }
  try {
    const path = req.url;
    let result: unknown;
    if (req.method === 'GET' && path === '/state') {
      result = { pid: process.pid, instance, member, contexts: Object.fromEntries(contexts) };
    } else if (req.method === 'POST' && path === '/seed') {
      assert.equal(seeded, false); seeded = true;
      const row = await store.reserve(); assert.ok(row); member = row.identity;
      await accounts.importCopilotOauthToken({ identity: member, ssoUser: member, ghLogin: 'synthetic-gh-process', copilotOauthToken: tokenA });
      assert.equal(await store.update(member, { state: 'provisioning', stage: 'warmup', sso_created_at: createdAt }), true);
      await worker.tick();
      assert.equal((await store.inventory(member))?.state, 'ready');
      assert.notEqual((await store.inventory(member))?.verified_at, null);
      result = { member };
    } else if (req.method === 'POST' && (path === '/rotate-aba' || path === '/rotate-ab')) {
      assert.ok(member && seeded);
      for (const token of path === '/rotate-aba' ? [tokenB, tokenA] : [tokenB]) await accounts.importCopilotOauthToken({ identity: member, ssoUser: member,
        ghLogin: 'synthetic-gh-process', copilotOauthToken: token });
      result = { generation: (await store.inventory(member))!.generation };
    } else if (req.method === 'POST' && path === '/tick') {
      await worker.tick(); result = { ticked: true };
    } else if (req.method === 'POST' && path === '/clear-cache') {
      for (const row of await store.accounts() as Array<{ identity: string }>) client.clearModelsCache(row.identity);
      result = { cleared: true };
    } else { res.writeHead(404).end('Unknown fixture command'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  } catch { res.writeHead(500).end('Fixture command failed'); }
});
servers.push(control); control.requestTimeout = 30000; control.headersTimeout = 10000;
control.listen(0, '127.0.0.1');
await bounded(once(control, 'listening'), 'control listen');
const origin = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.send!({ type: 'ready', pid: process.pid, instance, proxy: origin(proxy), control: origin(control) });
