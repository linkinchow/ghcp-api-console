// Test-only analogue of replicas-child: identical production mount/provisioning seam,
// with finite soak lifetime and bounded resource counters instead of an owner ledger.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiKey, bounded, domain, internalKey, model, origin, osKeys, replicaCount, token } from './replicas-safety.js';
import { cleanupSeconds, gate, integer, maxDurationSeconds } from './stream-soak-safety.js';

const db = gate(process.env);
assert.equal(process.env.STREAM_SOAK_CHILD, '1'); assert.equal(process.argv.length, 2);
assert.ok(process.send && process.connected, 'REFUSED: parent IPC required');
assert.match(db.pathname, /^\/ghcp_pool_test_[a-f0-9]{32}$/);
const count = replicaCount(process.env.STREAM_SOAK_REPLICAS ?? '');
const lifetimeMs = integer(process.env.STREAM_SOAK_LIFETIME ?? '', 60, maxDurationSeconds + cleanupSeconds, 'child lifetime') * 1000;
const streamSeconds = integer(process.env.STREAM_SOAK_STREAM ?? '', 10, 60, 'stream');
const mockOrigin = origin(process.env.STREAM_SOAK_MOCK_ORIGIN!);
const key = process.env.STREAM_SOAK_CONTROL_KEY!; assert.match(key, /^[a-f0-9]{64}$/);
const instance = randomUUID(); const dotenvPath = join(tmpdir(), `stream-soak-missing-${randomUUID()}`, '.env');
assert.equal(existsSync(dotenvPath), false);
for (const name of Object.keys(process.env)) if (!osKeys.includes(name)) delete process.env[name];
Object.assign(process.env, {
  TSX_TSCONFIG_PATH: fileURLToPath(new URL('./stream-soak-tsconfig.json', import.meta.url)),
  DOTENV_CONFIG_PATH: dotenvPath, NODE_ENV: 'test', STORAGE_DRIVER: 'mysql', MYSQL_URL: db.toString(),
  MYSQL_CONNECTION_LIMIT: '4', MYSQL_SSL_MODE: 'disabled', MYSQL_SSL_CA_PATH: '', DB_PATH: ':memory:', PORT: '3000',
  ACCOUNT_ROUTING_MODE: 'caller-lease', API_KEY: apiKey, INTERNAL_API_TOKEN: internalKey,
  IDENTITY_HEADER: 'X-User-Identity', IDENTITY_HEADER_REQUIRED: 'true', CLAUDE_CODE_OPTIMIZED: 'false',
  COPILOT_API_BASE_URL: mockOrigin, SSO_BASE_URL: mockOrigin, LOGIN_BASE_URL: mockOrigin,
  PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false', PROXY_INSTANCE_ID: instance, REQUEST_STATS_PER_ACCOUNT_LIMIT: '100',
  POOL_ACCOUNT_EMAIL_DOMAIN: domain, POOL_WARMUP_MODEL: model, READY_IDLE_TARGET: String(count + 2), POOL_MAX_ACCOUNTS: '20',
  POOL_REQUEST_TIMEOUT_SECONDS: String(streamSeconds + 15), CALLER_LEASE_TTL_SECONDS: '3600', PROVISIONAL_LEASE_TTL_SECONDS: '300',
  PREWARM_POLL_SECONDS: '1', PREWARM_CONCURRENCY: '1', POOL_LOGIN_MAX_PENDING: '1', POOL_EXHAUSTED_RETRY_AFTER_SECONDS: '1',
});
assert.equal(import.meta.resolve('@ghcp/shared'), new URL('../../src/packages/shared/src/index.ts', import.meta.url).href);
const servers: Server[] = []; const cleanup: Array<() => Promise<void>> = [];
let closing = false; let unexpected = 0;
const lifetime = setTimeout(() => { void shutdown(1); }, lifetimeMs);
async function shutdown(code = 0) {
  if (closing) return; closing = true; clearTimeout(lifetime);
  const force = setTimeout(() => process.exit(1), 5000);
  try {
    for (const server of servers) { server.closeAllConnections(); server.close(); }
    for (const step of cleanup) { try { await step(); } catch { code = 1; } }
  } finally { clearTimeout(force); process.exit(code); }
}
process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown') void shutdown(); });
process.once('disconnect', () => { void shutdown(1); }); process.once('SIGTERM', () => { void shutdown(); });
const nativeFetch = globalThis.fetch;
interface StreamContext { requestId: string; response: { destroyed: boolean }; upstreamSignal?: AbortSignal; }
const requestContext = new AsyncLocalStorage<StreamContext>();
const activeRequests = new Map<string, StreamContext>();
const cancelIntents = new Set<string>();
globalThis.fetch = (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(target.origin, mockOrigin, 'No upstream outside fixture'); assert.equal(target.hash, '');
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  const api = target.pathname.startsWith('/api/');
  const user = /^\/api\/users\/[a-z]+\.[a-z]+[0-9]{2}$/.test(target.pathname);
  const credentials = /^\/api\/users\/[a-z]+\.[a-z]+[0-9]{2}\/login-credentials$/.test(target.pathname);
  const task = /^\/api\/tasks\/[a-f0-9-]{36}$/.test(target.pathname);
  assert.ok(method === 'GET' && (user || task || target.pathname === '/models' || target.pathname === '/api/tasks')
    || method === 'POST' && (credentials || ['/api/users', '/api/tasks', '/v1/messages'].includes(target.pathname)));
  if (target.pathname !== '/api/tasks' || method !== 'GET') assert.equal(target.search, '');
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (api) assert.equal(headers.get('x-internal-token'), internalKey);
  else assert.match(headers.get('authorization') ?? '', /^Bearer synthetic-replicas-token-[a-z]+\.[a-z]+[0-9]{2}$/);
  const context = requestContext.getStore();
  if (context && target.pathname === '/v1/messages') context.upstreamSignal = init?.signal ?? undefined;
  headers.set('x-replicas-pid', String(process.pid)); return nativeFetch(input, { ...init, headers, redirect: 'error' });
};
try {
  const [expressModule, runtime, storage, accounts, auth, identity, routes, mysqlStore, mysqlStorage] = await Promise.all([
    import('express'), import('../../src/proxy/src/userPool/runtime.js'), import('../../src/proxy/src/db/connection.js'),
    import('../../src/proxy/src/db/accountsRepo.js'), import('../../src/proxy/src/auth/apiKey.js'), import('../../src/proxy/src/auth/identityHeader.js'),
    import('../../src/proxy/src/routes/compatible.js'), import('../../src/proxy/src/userPool/mysqlStore.js'), import('../../src/proxy/src/db/mysqlStorage.js'),
  ]);
  cleanup.push(() => runtime.stopUserPool(), () => storage.closeStorage());
  const store = await runtime.getUserPool(); assert.ok(store instanceof mysqlStore.MysqlPoolStore);
  const actualStorage = storage.getStorage(); assert.ok(actualStorage instanceof mysqlStorage.MysqlStorage);
  let owner: string | undefined; let acquisitions = 0;
  const claimOwner = store.claimOwner.bind(store);
  store.claimOwner = async value => { const claimed = await claimOwner(value); if (claimed) { owner = value; acquisitions++; } return claimed; };
  // Read-only mysql2 implementation diagnostics; never intercept acquisition/release.
  const raw = (actualStorage as unknown as { pool: { pool: { _allConnections: { length: number }; _freeConnections: { length: number }; _connectionQueue: { length: number } } } }).pool.pool;
  const { Logger } = await import('../../src/proxy/src/logger.js');
  const error = Logger.prototype.error;
  // Pass-through production logger observation. The native ERROR still reaches
  // stderr; IPC carries only synthetic request ID and booleans, never raw fields.
  Logger.prototype.error = function(event, message, fields) {
    if (event === 'upstream-stream-failed') {
      const context = requestContext.getStore();
      const armed = Boolean(context && cancelIntents.delete(context.requestId));
      process.send?.({ type: 'stream-failure', pid: process.pid, requestId: context?.requestId ?? '', armed,
        upstreamAborted: context?.upstreamSignal?.aborted === true, downstreamClosed: context?.response.destroyed === true });
    }
    return error.call(this, event, message, fields);
  };
  const app = expressModule.default();
  app.use(expressModule.default.json({ limit: '16kb' }), auth.requireApiKey, identity.requireIdentityHeader);
  app.use((req, res, next) => {
    const requestId = req.body?.messages?.[0]?.content;
    if (req.path !== '/v1/messages' || typeof requestId !== 'string' || !/^stream-soak-[0-4]-[1-9][0-9]*-(full|cancel|recover)$/.test(requestId)) return next();
    assert.ok(activeRequests.size < 5 && !activeRequests.has(requestId));
    const context: StreamContext = { requestId, response: res }; activeRequests.set(requestId, context);
    res.once('close', () => { activeRequests.delete(requestId); });
    requestContext.run(context, next);
  });
  app.use(runtime.routeUserPool);
  app.use(routes.compatibleRouter);
  const proxy = app.listen(0, '127.0.0.1'); servers.push(proxy); await bounded(once(proxy, 'listening'), 'proxy listen');
  let started = false;
  const control = createServer((req, res) => {
    void (async () => {
      if (closing || req.socket.remoteAddress !== '127.0.0.1' || req.headers.authorization !== `Bearer ${key}`) { res.writeHead(403).end(); return; }
      let result: unknown;
      if (req.method === 'GET' && req.url === '/state') {
        const connections = await Promise.all(servers.map(server => new Promise<number>((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count)))));
        result = { pid: process.pid, instance, owner, acquisitions, unexpected, scheduler: runtime.getLocalUserPoolSchedulerSnapshot(),
          memory: process.memoryUsage(), cpu: process.cpuUsage(), resource: process.resourceUsage(), connections,
          pool: { total: raw._allConnections.length, free: raw._freeConnections.length, queue: raw._connectionQueue.length } };
      } else if (req.method === 'POST' && req.url === '/start') {
        assert.equal(started, false); started = true; await runtime.startUserPool(); result = { started: true };
      } else if (req.method === 'POST' && req.url === '/expect-cancel') {
        let text = ''; for await (const chunk of req) { text += String(chunk); assert.ok(Buffer.byteLength(text) <= 256); }
        const body = JSON.parse(text) as { requestId: string };
        assert.match(body.requestId, /^stream-soak-[0-4]-[1-9][0-9]*-cancel$/);
        const context = activeRequests.get(body.requestId); assert.ok(context && !context.response.destroyed && context.upstreamSignal && !context.upstreamSignal.aborted);
        assert.ok(cancelIntents.size < 5 && !cancelIntents.has(body.requestId)); cancelIntents.add(body.requestId); result = { armed: true, pid: process.pid };
      } else if (req.method === 'POST' && req.url === '/oauth-callback') {
        let text = ''; for await (const chunk of req) { text += String(chunk); assert.ok(Buffer.byteLength(text) <= 2048); }
        const body = JSON.parse(text) as { identity: string; nonce: string };
        assert.match(body.identity, /^[a-z]+\.[a-z]+[0-9]{2}$/); assert.match(body.nonce, /^[a-f0-9-]{36}$/);
        const row = await store.inventory(body.identity); assert.ok(row); assert.equal(row.oauth_attempt_id, body.nonce);
        assert.ok(await accounts.saveCopilotOauthToken(body.identity, body.nonce, token(body.identity), `${body.identity}_synthetic`));
        result = { saved: true };
      } else { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    })().catch(() => { unexpected++; if (!res.headersSent) res.writeHead(500).end('Fixture control failed'); else res.destroy(); });
  });
  servers.push(control); control.requestTimeout = 10000; control.headersTimeout = 5000;
  control.listen(0, '127.0.0.1'); await bounded(once(control, 'listening'), 'control listen');
  const address = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.send!({ type: 'ready', pid: process.pid, instance, proxy: address(proxy), control: address(control) });
} catch { process.send?.({ type: 'fatal' }); await shutdown(1); }
