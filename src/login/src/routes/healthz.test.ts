import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.DB_PATH = ':memory:';
process.env.LOG_LEVEL = 'error';
const { loginFixtureRegistry } = await import('../testing/enterpriseFixture.js');
const { setLoginEnterprisesForTesting } = await import('../enterprises.js');
setLoginEnterprisesForTesting(loginFixtureRegistry());
const { buildApp } = await import('../server.js');

test('/healthz reports the release line of the image; single when GHCP_RELEASE_LINE is unset', async (t) => {
  const original = process.env.GHCP_RELEASE_LINE;
  const server = buildApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    if (original === undefined) delete process.env.GHCP_RELEASE_LINE;
    else process.env.GHCP_RELEASE_LINE = original;
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/healthz`;
  delete process.env.GHCP_RELEASE_LINE;
  assert.deepEqual(await (await fetch(url)).json(), { status: 'ok', service: 'login', releaseLine: 'single' });
  process.env.GHCP_RELEASE_LINE = 'multi';
  assert.deepEqual(await (await fetch(url)).json(), { status: 'ok', service: 'login', releaseLine: 'multi' });
});
