import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import express from 'express';
import { serviceProxy } from './apiProxy.js';
import { config } from './config.js';

const PROXY = 'https://models-relay.example.test';

/** Console relay in front of a fake Proxy; real network calls go only to the local test server. */
async function relay(t: TestContext, upstream: (url: string, init?: RequestInit) => Promise<Response>): Promise<string> {
  const savedUrl = config.proxyBaseUrl;
  config.proxyBaseUrl = PROXY;
  t.after(() => { config.proxyBaseUrl = savedUrl; });
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(PROXY)) return upstream(url, init);
    assert.ok(url.startsWith('http://127.0.0.1:'), `unexpected destination ${url}`);
    return nativeFetch(input, init);
  });
  const app = express();
  app.use('/api/console/proxy', serviceProxy('proxy', '/api/console/proxy'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/console/proxy`;
}

test('the Models relay cancels the upstream GET when the browser disconnects', async (t) => {
  let entered!: () => void;
  let cancelled!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const stopped = new Promise<void>((resolve) => { cancelled = resolve; });
  const base = await relay(t, (url, init) => {
    assert.equal(url, `${PROXY}/api/models?refresh=true`);
    assert.equal(init?.method, 'GET');
    entered();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { cancelled(); reject(new Error('synthetic-secret-error')); }, { once: true });
    });
  });

  const controller = new AbortController();
  const pending = fetch(`${base}/models?refresh=true`, { signal: controller.signal });
  const rejected = assert.rejects(pending, (error: Error) => error.name === 'AbortError');
  await started;
  controller.abort();
  await Promise.all([stopped, rejected]);
});

test('the Models relay replaces upstream transport errors with a fixed message', async (t) => {
  const base = await relay(t, async () => { throw new Error('private-token-that-must-not-escape'); });
  const response = await fetch(`${base}/models`);
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.equal(text.includes('private-token'), false);
  assert.match(text, /models_service_unavailable/);
});
