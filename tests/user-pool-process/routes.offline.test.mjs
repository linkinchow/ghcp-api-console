import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { engineEnabled, loopbackOrigin, mysqlGate } from './routes.safety.ts';

const valid = { MYSQL_POOL_PROCESS_ROUTES_TEST: '1', MYSQL_POOL_TEST_DISPOSABLE: '1',
  MYSQL_TEST_URL: 'mysql://root:synthetic@127.0.0.1:3306/ghcp_pool_test_optin' };

test('offline guard rejects absent opt-in and unsafe MySQL/control URLs', () => {
  assert.throws(() => mysqlGate({}), /REFUSED/);
  assert.equal(engineEnabled({}), false);
  assert.equal(engineEnabled(valid), true);
  assert.throws(() => engineEnabled({ MYSQL_POOL_PROCESS_ROUTES_TEST: '1' }), /REFUSED/);
  assert.throws(() => mysqlGate({ ...valid, MYSQL_POOL_PROCESS_ROUTES_TEST: '' }));
  assert.throws(() => mysqlGate({ ...valid, MYSQL_POOL_TEST_DISPOSABLE: '' }));
  for (const url of [
    'mysql://root:x@192.0.2.1/ghcp_pool_test_x', 'mysql://user:x@127.0.0.1/ghcp_pool_test_x',
    'mysql://root:x@127.0.0.1/production', 'mysql://root:x@127.0.0.1/',
    'mysql://root:x@127.0.0.1/ghcp_pool_test_x?socketPath=test', 'mysql://root:x@127.0.0.1/ghcp_pool_test_x#fragment',
    'https://root:x@127.0.0.1/ghcp_pool_test_x',
    'mysql://%72oot:x@127.0.0.1/ghcp_pool_test_x', 'mysql://root:x@127.0.0.1/ghcp_pool_test_x/extra',
    'mysql://root:x@localhost.example/ghcp_pool_test_x', 'mysql://root:x@127.0.0.1/ghcp_pool_test_x%2fy',
  ]) assert.throws(() => mysqlGate({ ...valid, MYSQL_TEST_URL: url }), url);
  assert.equal(mysqlGate(valid).hostname, '127.0.0.1');
  for (const host of ['localhost', '[::1]']) assert.equal(mysqlGate({ ...valid, MYSQL_TEST_URL: `mysql://root:x@${host}/ghcp_pool_test_x` }).hostname, host);
  for (const url of ['http://localhost:4321', 'http://127.0.0.1:4321/path', 'https://127.0.0.1:4321', 'http://127.0.0.1:4321?x=1', 'http://127.0.0.1']) assert.throws(() => loopbackOrigin(url));
});

test('offline entrypoints refuse before process spawn, HTTP listeners, sockets or fetch', async () => {
  let attempts = 0;
  const restored = [];
  const deny = () => { attempts++; throw new Error('Offline test forbids side effects'); };
  for (const [object, keys] of [
    [net, ['connect', 'createConnection', 'createServer']], [net.Socket.prototype, ['connect']],
    [http, ['createServer', 'request', 'get']], [https, ['request', 'get']],
    [childProcess, ['spawn', 'spawnSync', 'fork', 'exec', 'execSync', 'execFile', 'execFileSync']],
    [globalThis, ['fetch']],
  ]) for (const key of keys) { restored.push([object, key, object[key]]); object[key] = deny; }
  syncBuiltinESMExports();
  const names = ['MYSQL_POOL_PROCESS_ROUTES_TEST', 'MYSQL_POOL_TEST_DISPOSABLE', 'MYSQL_TEST_URL'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    await assert.rejects(import('./routes.child.ts?offline=absent'), /REFUSED/);
    Object.assign(process.env, { MYSQL_POOL_PROCESS_ROUTES_TEST: '1' });
    for (const file of ['routes.mysql.test.ts', 'routes.child.ts']) await assert.rejects(import(`./${file}?offline=missing-disposable`), /REFUSED/);
    Object.assign(process.env, valid, { MYSQL_TEST_URL: 'mysql://root:x@192.0.2.1/ghcp_pool_test_x' });
    for (const file of ['routes.mysql.test.ts', 'routes.child.ts']) await assert.rejects(import(`./${file}?offline=remote`), /loopback/);
    assert.equal(attempts, 0, 'Entrypoints must reject without even attempting a side effect');
  } finally {
    for (const [object, key, value] of restored) object[key] = value;
    syncBuiltinESMExports();
    for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  }
});
