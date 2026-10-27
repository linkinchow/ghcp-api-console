import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { deflateSync, gzipSync } from 'node:zlib';
import { buildApp } from './server.js';

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
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`;
  const json = JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'x' }] });
  const post = (body: Uint8Array<ArrayBuffer> | string, headers: Record<string, string>) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

  for (const [encoding, body] of Object.entries(compressed(json))) {
    const response = await post(body, { 'content-encoding': encoding });
    assert.equal(response.status, 415, encoding);
    assert.match(await response.text(), /content encoding unsupported/i);
  }
  // The parser still reads identity bodies: malformed JSON is rejected by it, valid JSON passes on to the routes.
  assert.equal((await post('{"model":', {})).status, 400);
  assert.equal((await post(json, { 'content-encoding': 'identity' })).status, 401);
  assert.equal((await post(json, {})).status, 401);
});
