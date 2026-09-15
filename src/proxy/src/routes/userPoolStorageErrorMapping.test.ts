import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { config } from '../config.js';
import { copilotAuthManager } from '../copilot/copilotAuthManager.js';
import { clearModelsCache } from '../copilot/copilotClient.js';
import { importCopilotOauthToken } from '../db/accountsRepo.js';
import { closeStorage, getStorage } from '../db/connection.js';
import { MysqlStorage } from '../db/mysqlStorage.js';
import { buildApp } from '../server.js';
import { MysqlDeadlineError } from '../userPool/mysqlDeadline.js';
import { getUserPool, stopUserPool } from '../userPool/runtime.js';
import { UserPoolStore } from '../userPool/store.js';

const originalFetch = globalThis.fetch;
const caller = `sha256:${'d'.repeat(64)}`;
const rawConnectionError = () => Object.assign(new Error('read ECONNRESET private-db.test:3306'), { code: 'ECONNRESET' });

function failingStorage(cause: unknown) {
  let calls = 0;
  const connection = {
    async execute() { throw cause; }, release() {}, destroy() {},
  } as unknown as PoolConnection;
  const pool = { async getConnection() { calls++; return connection; } } as unknown as Pool;
  return { storage: new MysqlStorage(pool, 100), calls: () => calls };
}

async function fixture(t: TestContext, direct = false) {
  const savedConfig = { ...config };
  const env = {
    ACCOUNT_ROUTING_MODE: direct ? 'direct' : 'caller-lease', STORAGE_DRIVER: 'sqlite',
    POOL_ACCOUNT_EMAIL_DOMAIN: 'storage-error-mapping.test', POOL_WARMUP_MODEL: 'test-model',
    READY_IDLE_TARGET: '1', POOL_MAX_ACCOUNTS: '2', POOL_REQUEST_TIMEOUT_SECONDS: '10',
  };
  const savedEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  Object.assign(config, { apiKey: 'storage-error-mapping-test', storageDriver: 'sqlite',
    dbPath: ':memory:', claudeCodeOptimized: true, requestStatsPerAccountLimit: 100 });
  const pool = await getUserPool();
  let member = 'direct-storage-mapping';
  if (!direct) {
    assert.ok(pool instanceof UserPoolStore);
    member = pool.reserve()!.identity;
    await importCopilotOauthToken({ identity: member, ssoUser: member, ghLogin: 'synthetic', copilotOauthToken: 'synthetic-token' });
    pool.update(member, { state: 'ready', stage: 'ready', verified_at: pool.now() });
  }
  clearModelsCache(member);
  const escaped: unknown[] = [];
  const app = buildApp();
  app.use((error: unknown, _req: Request, res: ExpressResponse, _next: NextFunction) => {
    escaped.push(error);
    res.status(500).json({ error: 'unhandled-test-error' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    t.mock.restoreAll();
    clearModelsCache(member);
    await stopUserPool();
    await closeStorage();
    Object.assign(config, savedConfig);
    for (const key of Object.keys(env)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });
  return {
    pool: pool as UserPoolStore, member, escaped,
    request: (path = '/v1/models') => originalFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
      method: path === '/v1/models' ? 'GET' : 'POST', signal: AbortSignal.timeout(3000),
      headers: { Authorization: `Bearer ${config.apiKey}`, 'X-User-Identity': direct ? member : caller, 'Content-Type': 'application/json' },
      body: path === '/v1/models' ? undefined : JSON.stringify({
        model: 'claude-opus-5-2', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
      }),
    }),
  };
}

async function assertStorageUnavailable(response: Response): Promise<void> {
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '1');
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  assert.deepEqual(await response.json(), {
    type: 'error', error: { type: 'api_error', code: 'pool_storage_unavailable', message: 'pool_storage_unavailable' },
  });
}

for (const path of ['/v1/models', '/chat/completions', '/responses', '/v1/messages', '/v1/messages/count_tokens']) {
  test(`tagged credential connectivity failure uses safe 503 on ${path}`, async t => {
    const f = await fixture(t);
    const failed = failingStorage(rawConnectionError());
    t.mock.method(getStorage(), 'getAccount', (identity: string) => failed.storage.getAccount(identity));
    let upstream = 0;
    t.mock.method(globalThis, 'fetch', async () => { upstream++; throw new Error('must not forward'); });
    await assertStorageUnavailable(await f.request(path));
    assert.equal(failed.calls(), 1);
    assert.equal(upstream, 0);
    assert.deepEqual(f.escaped, []);
  });
}

for (const status of [401, 429]) {
  for (const kind of ['connectivity', 'deadline'] as const) {
    test(`models ${status} recovery ${kind} failure cannot escape the safe JSON path`, async t => {
      const f = await fixture(t);
      const failed = failingStorage(rawConnectionError());
      let recoveries = 0;
      const recover = async () => {
        recoveries++;
        if (kind === 'deadline') throw new MysqlDeadlineError('query');
        await failed.storage.getAccount(f.member);
      };
      t.mock.method(f.pool, status === 401 ? 'recoverUnauthorized' : 'cool', recover);
      t.mock.method(globalThis, 'fetch', async () => new Response('{}', {
        status, headers: { 'Content-Type': 'application/json', 'Retry-After': '7' },
      }));
      await assertStorageUnavailable(await f.request());
      assert.equal(recoveries, 1);
      assert.equal(failed.calls(), kind === 'connectivity' ? 1 : 0);
      assert.deepEqual(f.escaped, []);
    });
  }
}

test('direct models invalidation connectivity failure uses safe JSON too', async t => {
  const f = await fixture(t, true);
  const failed = failingStorage(rawConnectionError());
  t.mock.method(copilotAuthManager, 'getAuth', async () => ({ identity: f.member, accessToken: 'synthetic-token', api: config.copilotApiBaseUrl }));
  t.mock.method(copilotAuthManager, 'invalidate', async () => { await failed.storage.getAccount(f.member); });
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }));
  await assertStorageUnavailable(await f.request());
  assert.equal(failed.calls(), 1);
  assert.deepEqual(f.escaped, []);
});

test('models recovery generic SQL errors retain their identity rather than becoming 503', async t => {
  const f = await fixture(t);
  const cause = Object.assign(new Error('SQL syntax failure'), { code: 'ER_PARSE_ERROR' });
  const failed = failingStorage(cause);
  t.mock.method(f.pool, 'recoverUnauthorized', async () => { await failed.storage.getAccount(f.member); });
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }));
  const response = await f.request();
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('retry-after'), null);
  assert.deepEqual(f.escaped, [cause]);
  await response.text();
});

for (const status of [401, 429]) {
  test(`models upstream ${status} keeps its existing mapping when recovery succeeds`, async t => {
    const f = await fixture(t);
    t.mock.method(globalThis, 'fetch', async () => new Response('{}', {
      status, headers: { 'Content-Type': 'application/json', 'Retry-After': '7' },
    }));
    const response = await f.request();
    assert.equal(response.status, status);
    assert.equal(response.headers.get('retry-after'), '7');
    assert.equal((await response.json() as { error: { code?: string } }).error.code, undefined);
    assert.deepEqual(f.escaped, []);
  });
}

for (const stage of ['admission', 'credentials', 'upstream'] as const) {
  test(`untagged application/network error during ${stage} keeps its existing mapping`, async t => {
    const f = await fixture(t);
    const cause = rawConnectionError();
    if (stage === 'admission') t.mock.method(f.pool, 'acquireCatalog', () => { throw cause; });
    else if (stage === 'credentials') t.mock.method(getStorage(), 'getAccount', async () => { throw cause; });
    else t.mock.method(globalThis, 'fetch', async () => { throw cause; });
    const response = await f.request();
    assert.equal(response.status, stage === 'admission' ? 500 : 502);
    assert.equal(response.headers.get('retry-after'), null);
    const body = await response.json() as { error: { code?: string; message?: string } };
    if (stage === 'admission') assert.deepEqual(f.escaped, [cause]);
    else {
      assert.deepEqual(f.escaped, []);
      assert.equal(body.error.code, undefined);
      assert.equal(body.error.message, cause.message);
    }
  });
}
