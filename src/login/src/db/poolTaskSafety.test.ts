import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

test('Login task mutations preserve pool recovery evidence and fail closed', async (t) => {
  process.env.DB_PATH = ':memory:';
  process.env.INTERNAL_API_TOKEN = 'login-protection-test';
  process.env.PROXY_BASE_URL = 'https://proxy.test';
  process.env.LOG_LEVEL = 'error';
  const { tasksApiRouter } = await import('../routes/tasksApi.js');
  const { createTask, getTask, markSuccess } = await import('./tasksRepo.js');
  const { requireInternalToken } = await import('../auth/internalAuth.js');
  const { getDb } = await import('./connection.js');
  const app = express();
  app.use(express.json());
  app.use('/api', requireInternalToken, tasksApiRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const original = globalThis.fetch;
  let protection: unknown = { managed: true, referenced: true };
  let unavailable = false;
  let lookups = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === base) return original(input, init);
    assert.equal(url.origin, 'https://proxy.test');
    assert.ok(url.pathname.endsWith('/login-task-protection'));
    assert.equal(new Headers(init?.headers).get('X-Internal-Token'), 'login-protection-test');
    assert.equal(url.searchParams.get('oauthAttemptId'), 'attempt-test');
    lookups++;
    if (unavailable) throw new Error('private upstream failure');
    return new Response(JSON.stringify(protection), { headers: { 'Content-Type': 'application/json' } });
  };
  const seed = (identity: string) => createTask({ identity, ssoUser: identity, ghLogin: `${identity}_test`, oauthAttemptId: 'attempt-test', ssoType: 'custom' });
  const request = (id: string, operation: 'delete' | 'retry', authenticated = true) => fetch(`${base}/api/tasks/${id}${operation === 'retry' ? '/retry' : ''}`, {
    method: operation === 'delete' ? 'DELETE' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(authenticated ? { 'X-Internal-Token': 'login-protection-test' } : {}) },
    ...(operation === 'retry' ? { body: JSON.stringify({ ssoPassword: 'test-only' }) } : {}),
  });
  try {
    await t.test('referenced terminal tasks cannot be deleted or independently retried', async () => {
      const task = seed('pool-member');
      markSuccess(task.id);
      for (const operation of ['delete', 'retry'] as const) {
        const response = await request(task.id, operation);
        assert.equal(response.status, 409);
        assert.equal((await response.json() as { error: { code: string } }).error.code, 'pool_task_managed');
        assert.equal(getTask(task.id)?.status, 'success');
      }
      assert.equal(lookups, 2);
    });
    await t.test('unavailable and malformed ownership responses preserve task records', async () => {
      const task = seed('unavailable');
      markSuccess(task.id);
      for (const body of [undefined, {}, { managed: true }]) {
        unavailable = body === undefined;
        protection = body;
        const response = await request(task.id, 'delete');
        assert.equal(response.status, 503);
        const text = await response.text();
        assert.ok(text.includes('pool_membership_unavailable'));
        assert.ok(!text.includes('private upstream failure'));
        assert.ok(getTask(task.id));
      }
      unavailable = false;
    });
    await t.test('consumed pool history and unrelated direct history can be deleted', async () => {
      for (const managed of [true, false]) {
        protection = { managed, referenced: false };
        const task = seed(`history-${managed}`);
        markSuccess(task.id);
        assert.equal((await request(task.id, 'delete')).status, 204);
        assert.equal(getTask(task.id), undefined);
      }
    });
    await t.test('unauthorized, missing and pending tasks do not query Proxy', async () => {
      const before = lookups;
      const task = seed('pending');
      assert.equal((await request(task.id, 'delete', false)).status, 401);
      assert.equal((await request(task.id, 'delete')).status, 400);
      assert.equal((await request('absent', 'delete')).status, 404);
      assert.equal(lookups, before);
      assert.equal(getTask(task.id)?.status, 'pending');
    });
  } finally {
    globalThis.fetch = original;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    getDb().close();
  }
});
