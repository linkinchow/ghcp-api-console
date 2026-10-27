import assert from 'node:assert/strict';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { deflateSync, gzipSync } from 'node:zlib';
import { createEnterpriseFixture } from '../testing/enterpriseFixture.js';

const fixture = createEnterpriseFixture();
process.env.DB_PATH = ':memory:';
process.env.LOG_LEVEL = 'error';
const { setSsoEnterprisesForTesting } = await import('../enterprises.js');
setSsoEnterprisesForTesting(fixture.registry);
const { buildApp } = await import('../server.js');

const compressed = (text: string) =>
  ({ gzip: Uint8Array.from(gzipSync(text)), deflate: Uint8Array.from(deflateSync(text)) });

// CVE-2026-111181 mitigation: the JSON and urlencoded parsers run with inflate: false, so compressed request bodies
// are refused with 415 before any decompression stream exists; uncompressed bodies are parsed as before.
test('compressed JSON and urlencoded bodies get 415; uncompressed bodies are still parsed', async (t) => {
  const server = buildApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/login`;
  const bodies = {
    'application/json': JSON.stringify({ username: 'body-encoding-user', password: 'not-the-password' }),
    'application/x-www-form-urlencoded': 'username=body-encoding-user&password=not-the-password',
  };
  const post = (body: Uint8Array<ArrayBuffer> | string, headers: Record<string, string>) =>
    fetch(url, { method: 'POST', headers, body });

  for (const [type, text] of Object.entries(bodies)) {
    for (const [encoding, body] of Object.entries(compressed(text))) {
      const response = await post(body, { 'content-type': type, 'content-encoding': encoding });
      assert.equal(response.status, 415, `${type} ${encoding}`);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'unsupported_content_encoding');
    }
    // The login handler reads the parsed body: unknown credentials are a 401 login page, not a parse error.
    const plain = await post(text, { 'content-type': type });
    assert.equal(plain.status, 401, type);
    assert.match(await plain.text(), /Invalid username or password/);
    assert.equal((await post(text, { 'content-type': type, 'content-encoding': 'identity' })).status, 401, type);
  }
});
