import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { HeldLease } from './store.js';

const savedStartupEnv = { ...process.env };
Object.assign(process.env, { DOTENV_CONFIG_PATH: join(tmpdir(), `missing-timeout-test-${randomUUID()}.env`),
  STORAGE_DRIVER: 'sqlite', DB_PATH: ':memory:', ACCOUNT_ROUTING_MODE: 'direct', MYSQL_SSL_MODE: 'disabled' });
const [{ config }, { closeStorage }, { getUserPool, routeUserPool, stopUserPool }] = await Promise.all([
  import('../config.js'), import('../db/connection.js'), import('./runtime.js'),
]);
for (const key of Object.keys(process.env)) if (!(key in savedStartupEnv)) delete process.env[key];
Object.assign(process.env, savedStartupEnv);

const caller = `sha256:${'a'.repeat(64)}`;

class Response extends EventEmitter {
  locals: Record<string, any> = {};
  destroyed = false;
  writableEnded = false;
  writableFinished = false;
  headersSent = false;
  statusCode = 200;
  body: unknown;
  setHeader() { return this; }
  status(code: number) { this.statusCode = code; return this; }
  json(body: unknown) { this.body = body; this.writableEnded = true; this.emit('finish'); return this; }
  destroy() { this.destroyed = true; this.emit('close'); return this; }
}

test('runtime captures inference-only override without changing store config, catalog budgets or request payload', async () => {
  const savedEnv = { ...process.env }, savedConfig = { ...config };
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  try {
    Object.assign(config, { storageDriver: 'sqlite', dbPath: ':memory:' });
    Object.assign(process.env, { ACCOUNT_ROUTING_MODE: 'caller-lease', STORAGE_DRIVER: 'sqlite',
      POOL_ACCOUNT_EMAIL_DOMAIN: 'synthetic.example.test', POOL_WARMUP_MODEL: 'synthetic',
      READY_IDLE_TARGET: '0', POOL_MAX_ACCOUNTS: '4', POOL_REQUEST_TIMEOUT_SECONDS: '120',
      POOL_INFERENCE_TIMEOUT_SECONDS: '600' });
    await stopUserPool(); await closeStorage();
    const store = (await getUserPool())!;
    const acquired: Array<{ kind: string; override?: number }> = [];
    const finished: boolean[] = [];
    const held: HeldLease = { caller_id: caller, member_identity: 'synthetic-member', lease_id: 'synthetic-lease',
      phase: 'active', assigned_at: 1, expires_at: 1000000, last_success_at: 1,
      request_id: 'synthetic-request', kind: 'lease', deadline_at: 600000 };
    store.acquire = (_caller, _signal, override) => { acquired.push({ kind: 'lease', override }); return held; };
    store.acquireCatalog = () => { acquired.push({ kind: 'catalog' }); return { ...held, kind: 'catalog' }; };
    store.finish = (_held, success) => { finished.push(success); };
    store.event = () => {};
    const timers: Array<{ callback: () => void; delay: number }> = [];
    globalThis.setTimeout = ((callback: () => void, delay: number) => {
      timers.push({ callback, delay });
      return { unref() {} } as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;
    globalThis.setInterval = (() => ({ unref() {} } as unknown as NodeJS.Timeout)) as typeof setInterval;
    for (const path of ['/v1/messages', '/chat/completions', '/responses', '/v1/messages/count_tokens', '/v1/models']) {
      timers.length = 0;
      const method = path === '/v1/models' ? 'GET' : 'POST';
      const req = { method, path, identity: caller, body: { model: 'synthetic', timeout: 1,
        metadata: { POOL_INFERENCE_TIMEOUT_SECONDS: 1 } }, aborted: false };
      const res = new Response();
      let dispatched = false;
      await routeUserPool(req as any, res as any, error => { assert.equal(error, undefined); dispatched = true; });
      assert.equal(dispatched, true);
      const inference = method === 'POST' && path !== '/v1/messages/count_tokens';
      const budget = inference ? 600000 : 120000;
      assert.equal(timers[0].delay, budget);
      assert.ok(timers.at(-1)!.delay <= budget && timers.at(-1)!.delay > budget - 1000);
      assert.deepEqual(acquired.at(-1), inference ? { kind: 'lease', override: 600000 } : { kind: 'catalog' });
      assert.equal(res.locals.userPool.options.requestTimeoutMs, 120000);
      timers.at(-1)!.callback();
      assert.equal(res.statusCode, 504);
      assert.equal((res.body as any).error.code, 'pool_request_timeout');
      await res.locals.userPool.finish(false);
    }
    timers.length = 0;
    const res = new Response();
    await routeUserPool({ method: 'POST', path: '/v1/messages', identity: caller,
      body: { model: 'synthetic' }, aborted: false } as any, res as any, () => {});
    res.headersSent = true;
    timers.at(-1)!.callback();
    assert.equal(res.destroyed, true);
    assert.equal(res.body, undefined);
    assert.equal(res.locals.userPool.controller.signal.reason.message, 'Pool request deadline exceeded');
    await res.locals.userPool.finish(false);
    assert.ok(finished.every(success => success === false));
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
    await stopUserPool(); await closeStorage();
    Object.assign(config, savedConfig);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
