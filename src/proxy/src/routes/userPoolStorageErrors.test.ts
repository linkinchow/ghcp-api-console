import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { config } from '../config.js';
import { importCopilotOauthToken } from '../db/accountsRepo.js';
import { closeStorage, getStorage } from '../db/connection.js';
import { MysqlStorage } from '../db/mysqlStorage.js';
import { clearModelsCache } from '../copilot/copilotClient.js';
import { buildApp } from '../server.js';
import type { PoolConfig } from '../userPool/config.js';
import { MysqlPoolStore } from '../userPool/mysqlStore.js';
import { getUserPool, stopUserPool } from '../userPool/runtime.js';
import { UserPoolStore } from '../userPool/store.js';

const originalFetch = globalThis.fetch;
const caller = `sha256:${'a'.repeat(64)}`;
type FailureStage = 'admission' | 'credential lookup';
type ConnectivityCode = 'ECONNREFUSED' | 'ECONNRESET';

/** Inject at mysql2's promise boundary, not by throwing a domain error from a route/store stub. */
function failingDriver(code: ConnectivityCode) {
  const syscall = code === 'ECONNREFUSED' ? 'connect' : 'read';
  const error = Object.assign(new Error(`${syscall} ${code} 192.0.2.10:3306`), {
    code, errno: code === 'ECONNREFUSED' ? -111 : -104, syscall,
    address: '192.0.2.10', port: 3306, fatal: true,
  });
  const calls = { connections: 0, query: [] as string[], execute: [] as Array<{ sql: string; values: unknown[] }> };
  const connection = {
    async query(sql: string) { calls.query.push(sql); throw error; },
    async execute(sql: string, values: unknown[]) { calls.execute.push({ sql, values }); throw error; },
    release() {},
    destroy() {},
  } as unknown as PoolConnection;
  const pool = {
    async getConnection() {
      calls.connections++;
      if (code === 'ECONNREFUSED') throw error;
      return connection;
    },
    async end() {},
  } as unknown as Pool;
  return { pool, error, calls };
}

async function fixture(t: TestContext, stage: FailureStage, code: ConnectivityCode) {
  const savedConfig = { ...config };
  const env = {
    ACCOUNT_ROUTING_MODE: 'caller-lease', STORAGE_DRIVER: 'sqlite',
    POOL_ACCOUNT_EMAIL_DOMAIN: 'storage-errors.test', POOL_WARMUP_MODEL: 'test-model',
    READY_IDLE_TARGET: '1', POOL_MAX_ACCOUNTS: '2', POOL_REQUEST_TIMEOUT_SECONDS: '10',
  };
  const savedEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  let server: Server | undefined;
  let member: string | undefined;
  t.after(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    t.mock.restoreAll();
    if (member) clearModelsCache(member);
    await stopUserPool();
    await closeStorage();
    Object.assign(config, savedConfig);
    for (const key of Object.keys(env)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });
  Object.assign(process.env, env);
  Object.assign(config, { apiKey: 'pool-storage-errors-test-key', storageDriver: 'sqlite',
    dbPath: ':memory:', requestStatsPerAccountLimit: 100, claudeCodeOptimized: true });
  const driver = failingDriver(code);
  const storage = getStorage();
  if (stage === 'admission') {
    // Only startup/migrations are bypassed. Admission runs the real MySQL
    // transaction/acquisition/deadline path against the injected mysql2 Pool.
    t.mock.method(storage, 'userPool', async (options: PoolConfig) => new MysqlPoolStore(driver.pool, options));
  }
  const store = await getUserPool();
  let accountLookups = 0;
  if (stage === 'credential lookup') {
    // Keep admission and its first heartbeat real and healthy, then fail the
    // selected member's credential SELECT through MysqlStorage (not a generic Error stub).
    assert.ok(store instanceof UserPoolStore);
    const reserved = store.reserve()!;
    member = reserved.identity;
    clearModelsCache(member);
    await importCopilotOauthToken({ identity: member, ssoUser: member, ghLogin: 'synthetic', copilotOauthToken: 'synthetic-token' });
    store.update(member, { state: 'ready', stage: 'ready', verified_at: store.now() });
    const mysqlStorage = new MysqlStorage(driver.pool, 100);
    t.mock.method(storage, 'getAccount', async (identity: string) => {
      accountLookups++;
      assert.equal(identity, member, 'Credential lookup must target the admitted member, not the caller hash');
      assert.equal(store.hasHolds(identity), true, 'The real admission must have acquired its hold before the DB failure');
      return mysqlStorage.getAccount(identity);
    });
  } else {
    assert.ok(store instanceof MysqlPoolStore);
  }
  const upstreamCalls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    upstreamCalls.push(String(input));
    // Record even model discovery, and never make a real external request if a regression forwards.
    return new Response(JSON.stringify({ error: 'unexpected upstream forwarding in storage failure test' }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  });
  server = buildApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`;
  return {
    driver, store, member, upstreamCalls, accountLookups: () => accountLookups,
    request: () => originalFetch(url, {
      method: 'POST',
      // Raw connectivity failures are immediate: do not let the five-second SQL
      // deadline (or the ten-second request deadline) turn this into a timeout test.
      signal: AbortSignal.timeout(3000),
      headers: { Authorization: `Bearer ${config.apiKey}`, 'X-User-Identity': caller, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5-2', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
    }),
  };
}

async function assertSafeStorageFailure(response: Response, driverError: Error & { code: string }): Promise<void> {
  const text = await response.text();
  let body: { type?: string; error?: { code?: string; type?: string } } | undefined;
  try { body = JSON.parse(text) as typeof body; } catch { /* Include Express HTML/stack responses in the assertion below. */ }
  assert.deepEqual({
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    contentType: response.headers.get('content-type')?.split(';')[0],
    type: body?.type ?? null,
    errorType: body?.error?.type ?? null,
    code: body?.error?.code ?? null,
    leaksDriverDetails: text.includes(driverError.message) || text.includes(driverError.code) || text.includes('192.0.2.10'),
    leaksStack: /"stack"\s*:|<pre>|userPoolStorageErrors\.test\.ts|(?:\\n|\n)\s*at /i.test(text),
  }, {
    status: 503, retryAfter: '1', contentType: 'application/json',
    type: 'error', errorType: 'api_error', code: 'pool_storage_unavailable',
    leaksDriverDetails: false, leaksStack: false,
  }, `Recognized MySQL connectivity failures must use the safe storage envelope; received ${text}`);
}

for (const stage of ['admission', 'credential lookup'] as const) {
  for (const code of ['ECONNREFUSED', 'ECONNRESET'] as const) {
    test(`immediate MySQL ${code} during pool ${stage} returns safe 503 without forwarding`, async t => {
      const f = await fixture(t, stage, code);
      const response = await f.request();
      assert.equal(f.driver.calls.connections, 1, 'The request must reach the real storage driver boundary exactly once');
      assert.deepEqual(f.upstreamCalls, [], 'Storage failure must prevent model discovery and inference forwarding');
      assert.equal(f.accountLookups(), stage === 'credential lookup' ? 1 : 0);
      if (code === 'ECONNRESET') {
        if (stage === 'admission') {
          assert.equal(f.driver.calls.query.length, 1, 'The reset must originate in admission SQL');
          assert.equal(f.driver.calls.execute.length, 0);
        } else {
          assert.deepEqual(f.driver.calls.execute, [{ sql: 'SELECT * FROM proxy_accounts WHERE identity = ?', values: [f.member] }]);
          assert.equal(f.driver.calls.query.length, 0);
        }
      } else {
        assert.deepEqual(f.driver.calls.query, []);
        assert.deepEqual(f.driver.calls.execute, []);
      }
      if (f.store instanceof UserPoolStore) {
        for (let i = 0; i < 100 && f.store.hasHolds(f.member!); i++) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(f.store.hasHolds(f.member!), false, 'Credential failure must drain the admitted hold');
        assert.equal(f.store.leases().length, 1);
        assert.equal(f.store.leases()[0].phase, 'provisional', 'Failed credential lookup must not promote the lease');
      }
      await assertSafeStorageFailure(response, f.driver.error);
    });
  }
}
