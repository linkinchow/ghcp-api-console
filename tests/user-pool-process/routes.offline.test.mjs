import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { assertV5Production, engineEnabled, loopbackOrigin, mysqlGate, routesSuite, v5ProductionRef } from './routes.safety.ts';

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

test('offline suite selector preserves baseline and rejects unknown selections', () => {
  assert.equal(routesSuite({}), 'baseline');
  assert.equal(routesSuite({ MYSQL_POOL_PROCESS_ROUTES_SUITE: 'baseline' }), 'baseline');
  assert.equal(routesSuite({ MYSQL_POOL_PROCESS_ROUTES_SUITE: 'v5' }), 'v5');
  for (const value of ['', 'v4', 'all', 'V5']) assert.throws(() => routesSuite({ MYSQL_POOL_PROCESS_ROUTES_SUITE: value }), /REFUSED/);
});

test('offline v5 source preflight checks exact production content and rejects drift', async () => {
  const saved = childProcess.execFileSync;
  const calls = [];
  let mode = 'match';
  childProcess.execFileSync = (command, args, options) => {
    calls.push(args);
    assert.equal(command, 'git'); assert.equal(options.timeout, 5000);
    assert.equal(options.encoding, 'utf8'); assert.equal(options.stdio, 'pipe');
    if (args[0] === 'diff') {
      assert.deepEqual(args, ['diff', '--exit-code', v5ProductionRef, '--', 'src/proxy', 'src/packages/shared']);
      if (mode === 'drift') throw new Error('synthetic production mismatch');
      return '';
    }
    assert.deepEqual(args, ['ls-files', '--others', '--exclude-standard', '--', 'src/proxy', 'src/packages/shared']);
    return mode === 'untracked' ? 'src/proxy/src/untracked.ts\n' : '';
  };
  syncBuiltinESMExports();
  try {
    await assertV5Production(); assert.equal(calls.length, 2);
    mode = 'drift'; await assert.rejects(assertV5Production(), /synthetic production mismatch/);
    mode = 'untracked'; await assert.rejects(assertV5Production(), /untracked production/);
  } finally { childProcess.execFileSync = saved; syncBuiltinESMExports(); }
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
  const names = ['MYSQL_POOL_PROCESS_ROUTES_TEST', 'MYSQL_POOL_TEST_DISPOSABLE', 'MYSQL_TEST_URL', 'MYSQL_POOL_PROCESS_ROUTES_SUITE'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    await assert.rejects(import('./routes.child.ts?offline=absent'), /REFUSED/);
    for (const suite of ['baseline', 'v5']) {
      for (const name of names) delete process.env[name];
      Object.assign(process.env, { MYSQL_POOL_PROCESS_ROUTES_TEST: '1', MYSQL_POOL_PROCESS_ROUTES_SUITE: suite });
      for (const file of ['routes.mysql.test.ts', 'routes.child.ts']) await assert.rejects(import(`./${file}?offline=${suite}-missing-disposable`), /REFUSED/);
      Object.assign(process.env, valid, { MYSQL_TEST_URL: 'mysql://root:x@192.0.2.1/ghcp_pool_test_x' });
      for (const file of ['routes.mysql.test.ts', 'routes.child.ts']) await assert.rejects(import(`./${file}?offline=${suite}-remote`), /loopback/);
    }
    Object.assign(process.env, valid, { MYSQL_POOL_PROCESS_ROUTES_SUITE: 'unknown' });
    await assert.rejects(import('./routes.mysql.test.ts?offline=unknown-suite'), /REFUSED/);
    assert.equal(attempts, 0, 'Entrypoints must reject without even attempting a side effect');
  } finally {
    for (const [object, key, value] of restored) object[key] = value;
    syncBuiltinESMExports();
    for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  }
});
