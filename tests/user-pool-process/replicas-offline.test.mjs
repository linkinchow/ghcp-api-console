import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { enabled, gate, origin, replicaCount } from './replicas-safety.ts';

const valid = { MYSQL_POOL_REPLICAS_TEST: '1', MYSQL_POOL_TEST_DISPOSABLE: '1',
  MYSQL_TEST_URL: 'mysql://root:synthetic@127.0.0.1:3306/ghcp_pool_test_optin' };
test('replicas offline guard rejects unsafe input and sizes', () => {
  assert.equal(enabled({}), false); assert.throws(() => gate({}), /REFUSED/); assert.equal(enabled(valid), true);
  for (const patch of [{ MYSQL_POOL_REPLICAS_TEST: '' }, { MYSQL_POOL_TEST_DISPOSABLE: '' }, { MYSQL_TEST_URL: '' }]) {
    assert.throws(() => gate({ ...valid, ...patch }), /REFUSED/);
  }
  for (const url of [
    'mysql://root:x@192.0.2.1/ghcp_pool_test_x', 'mysql://user:x@127.0.0.1/ghcp_pool_test_x',
    'mysql://root:x@127.0.0.1/production', 'mysql://root:x@127.0.0.1/',
    'mysql://root:x@127.0.0.1/ghcp_pool_test_x?socketPath=x', 'mysql://root:x@127.0.0.1/ghcp_pool_test_x#x',
    'https://root:x@127.0.0.1/ghcp_pool_test_x', 'mysql://%72oot:x@127.0.0.1/ghcp_pool_test_x',
    'mysql://root:x@localhost.example/ghcp_pool_test_x', 'mysql://root:x@127.0.0.1/ghcp_pool_test_x/extra',
  ]) assert.throws(() => gate({ ...valid, MYSQL_TEST_URL: url }), /REFUSED/);
  for (const url of ['http://localhost:3000', 'https://127.0.0.1:3000', 'http://127.0.0.1:3000/path', 'http://127.0.0.1:3000?x=1', 'http://127.0.0.1']) {
    assert.throws(() => origin(url));
  }
  assert.equal(origin('http://127.0.0.1:43210'), 'http://127.0.0.1:43210');
  assert.equal(replicaCount('3'), 3); assert.equal(replicaCount('5'), 5);
  for (const count of ['', '2', '4', '20', '03', '5 ']) assert.throws(() => replicaCount(count), /REFUSED/);
});
test('replicas entrypoints refuse before any network, listener or child process attempt', async () => {
  let attempts = 0; const restore = [];
  const deny = () => { attempts++; throw new Error('Side effect attempted by offline guard'); };
  for (const [object, keys] of [
    [net, ['connect', 'createConnection', 'createServer']], [net.Socket.prototype, ['connect']],
    [http, ['createServer', 'request', 'get']], [https, ['request', 'get']],
    [childProcess, ['spawn', 'spawnSync', 'fork', 'exec', 'execSync', 'execFile', 'execFileSync']], [globalThis, ['fetch']],
  ]) for (const name of keys) { restore.push([object, name, object[name]]); object[name] = deny; }
  syncBuiltinESMExports();
  const keys = ['MYSQL_POOL_REPLICAS_TEST', 'MYSQL_POOL_TEST_DISPOSABLE', 'MYSQL_TEST_URL'];
  const saved = Object.fromEntries(keys.map(name => [name, process.env[name]]));
  try {
    for (const name of keys) delete process.env[name];
    await assert.rejects(import('./replicas-child.ts?offline=absent'), /REFUSED/);
    await assert.rejects(import('./replicas-run.mjs?offline=absent'), /REFUSED/);
    const { fixture } = await import('./replicas-harness.ts');
    await assert.rejects(fixture({}, 3), /REFUSED/);
    for (const [tag, env] of [
      ['missing', { MYSQL_POOL_REPLICAS_TEST: '1' }],
      ['remote', { ...valid, MYSQL_TEST_URL: 'mysql://root:x@192.0.2.1/ghcp_pool_test_x' }],
    ]) {
      for (const name of keys) delete process.env[name]; Object.assign(process.env, env);
      for (const file of ['replicas-child.ts', 'replicas-mysql.test.ts', 'replicas-run.mjs']) await assert.rejects(import(`./${file}?offline=${tag}`), /REFUSED/);
      await assert.rejects(fixture({}, 5), /REFUSED/);
    }
    assert.equal(attempts, 0);
  } finally {
    for (const [object, name, value] of restore) object[name] = value;
    syncBuiltinESMExports();
    for (const name of keys) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  }
});
