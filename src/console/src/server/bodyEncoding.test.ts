import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { deflateSync, gzipSync } from 'node:zlib';
import { buildApp } from './app.js';

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
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/console/login`;
  const json = JSON.stringify({ username: 'body-encoding-admin', password: 'not-the-password' });
  const post = (body: Uint8Array<ArrayBuffer> | string, headers: Record<string, string>) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

  for (const [encoding, body] of Object.entries(compressed(json))) {
    const response = await post(body, { 'content-encoding': encoding });
    assert.equal(response.status, 415, encoding);
    assert.match(await response.text(), /content encoding unsupported/i);
  }
  // The login handler reads the parsed body: unknown credentials are a 401, not a parse or server error.
  const plain = await post(json, {});
  assert.equal(plain.status, 401);
  assert.equal(((await plain.json()) as { error: { code: string } }).error.code, 'login_failed');
  assert.equal((await post(json, { 'content-encoding': 'identity' })).status, 401);
  assert.equal((await post('{"username":', {})).status, 400);
});
