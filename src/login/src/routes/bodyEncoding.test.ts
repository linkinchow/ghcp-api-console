import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { deflateSync, gzipSync } from 'node:zlib';

const TOKEN = 'body-encoding-token';
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.DB_PATH = ':memory:';
process.env.INTERNAL_API_TOKEN = TOKEN;
process.env.LOG_LEVEL = 'error';
const { loginFixtureRegistry } = await import('../testing/enterpriseFixture.js');
const { setLoginEnterprisesForTesting } = await import('../enterprises.js');
setLoginEnterprisesForTesting(loginFixtureRegistry());
const { loginQueue } = await import('../tasks/queue.js');
const { buildApp } = await import('../server.js');

// Nothing in this file may start a browser: no task is ever valid here, and the queue accepts none.
loginQueue.stopAccepting();

const compressed = (text: string) =>
  ({ gzip: Uint8Array.from(gzipSync(text)), deflate: Uint8Array.from(deflateSync(text)) });

// CVE-2026-111181 mitigation: the JSON parser runs with inflate: false, so compressed request bodies are refused
// with 415 before any decompression stream exists; uncompressed bodies are parsed as before.
test('compressed JSON bodies get 415; uncompressed bodies are still parsed', async (t) => {
  const server = buildApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/enterprises/default/tasks`;
  // Rejected by the handler because of a field in the body, so a 400 naming it proves the body was parsed.
  const json = JSON.stringify({ selectors: { user: '#x' } });
  const post = (body: Uint8Array<ArrayBuffer> | string, headers: Record<string, string>) => fetch(url, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': TOKEN, ...headers }, body });

  for (const [encoding, body] of Object.entries(compressed(json))) {
    const response = await post(body, { 'content-encoding': encoding });
    assert.equal(response.status, 415, encoding);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'unsupported_content_encoding');
  }
  for (const headers of [{}, { 'content-encoding': 'identity' }] as Record<string, string>[]) {
    const response = await post(json, headers);
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'task_override_forbidden');
  }
});
