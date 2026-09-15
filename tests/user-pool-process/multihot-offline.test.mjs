import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { count, burst, hotCount, lockMs, responseMs, deadline, enabled, gate, productionMatch, productionPaths } from './multihot-safety.ts';

const valid = { MYSQL_POOL_MULTIHOT_TEST: '1', MYSQL_POOL_REPLICAS_TEST: '1', MYSQL_POOL_TEST_DISPOSABLE: '1',
  MYSQL_TEST_URL: 'mysql://root:synthetic@127.0.0.1:3306/ghcp_pool_test_optin' };
test('multihot fixed budget and explicit safe opt-ins', () => {
  assert.equal(count, 5); assert.equal(count * hotCount * burst, 60); assert.equal(lockMs, 6500); assert.equal(responseMs, 6500);
  assert.equal(enabled({}), false); assert.throws(() => gate({}), /REFUSED/); assert.equal(enabled(valid), true);
  for (const key of Object.keys(valid)) assert.throws(() => gate({ ...valid, [key]: '' }), /REFUSED/);
  for (const url of [
    'mysql://root:x@192.0.2.1/ghcp_pool_test_x', 'mysql://user:x@127.0.0.1/ghcp_pool_test_x',
    'mysql://root:x@127.0.0.1/production', 'mysql://root:x@127.0.0.1/',
    'mysql://root:x@127.0.0.1/ghcp_pool_test_x?socketPath=x', 'mysql://root:x@127.0.0.1/ghcp_pool_test_x#x',
    'https://root:x@127.0.0.1/ghcp_pool_test_x', 'mysql://%72oot:x@127.0.0.1/ghcp_pool_test_x',
    'mysql://root:x@localhost.example/ghcp_pool_test_x', 'mysql://root:x@127.0.0.1/ghcp_pool_test_x/extra',
  ]) assert.throws(() => gate({ ...valid, MYSQL_TEST_URL: url }), /REFUSED/);
  for (const patch of [{}, { MULTIHOT_RUNNER: '1' }, { MULTIHOT_RUNNER: '1', MULTIHOT_DEADLINE_AT: 'Infinity' },
    { MULTIHOT_RUNNER: '1', MULTIHOT_DEADLINE_AT: String(Date.now() + 120000) },
    { MULTIHOT_RUNNER: '1', MULTIHOT_DEADLINE_AT: String(Date.now() - 1000) }]) assert.throws(() => deadline(patch), /REFUSED/);
  assert.ok(deadline({ MULTIHOT_RUNNER: '1', MULTIHOT_DEADLINE_AT: String(Date.now() + 1000) }) > Date.now());
});
test('multihot allows test-only descendant HEAD but rejects production drift or dirty production', () => {
  const seen = [];
  productionMatch(args => { seen.push(args); return ''; });
  assert.deepEqual(seen.map(args => args[0]), ['merge-base', 'diff', 'status']);
  assert.ok(!seen.some(args => args[0] === 'rev-parse'), 'Not an exact HEAD check');
  assert.deepEqual(seen[1].slice(seen[1].indexOf('--') + 1), productionPaths);
  for (const command of ['merge-base', 'diff', 'status']) {
    assert.throws(() => productionMatch(args => {
      if (args[0] !== command) return '';
      if (command === 'merge-base') throw new Error('not descendant');
      return 'src/changed.ts';
    }));
  }
});
test('multihot offline entrypoints refuse before DB/network/listener/child/git side effects', async () => {
  let attempts = 0; const restore = [];
  const deny = () => { attempts++; throw new Error('Side effect attempted by offline guard'); };
  for (const [object, keys] of [
    [net, ['connect', 'createConnection', 'createServer']], [net.Socket.prototype, ['connect']],
    [http, ['createServer', 'request', 'get']], [https, ['request', 'get']],
    [childProcess, ['spawn', 'spawnSync', 'fork', 'exec', 'execSync', 'execFile', 'execFileSync']], [globalThis, ['fetch']],
  ]) for (const key of keys) { restore.push([object, key, object[key]]); object[key] = deny; }
  syncBuiltinESMExports();
  const keys = [...Object.keys(valid), 'MULTIHOT_RUNNER', 'MULTIHOT_DEADLINE_AT'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    const { fixture } = await import('./multihot-harness.ts');
    for (const [tag, env] of [
      ['absent', {}], ['incomplete', { MYSQL_POOL_MULTIHOT_TEST: '1' }],
      ['remote', { ...valid, MYSQL_TEST_URL: 'mysql://root:x@192.0.2.1/ghcp_pool_test_x' }],
      ['no-runner', valid],
    ]) {
      for (const key of keys) delete process.env[key]; Object.assign(process.env, env);
      for (const file of ['multihot-child.ts', ...(tag === 'absent' ? [] : ['multihot-mysql.test.ts']),
        ...(tag === 'no-runner' ? [] : ['multihot-run.mjs'])]) {
        await assert.rejects(import(`./${file}?offline=${tag}`), /REFUSED/);
      }
      await assert.rejects(fixture({}), /REFUSED/);
    }
    assert.equal(attempts, 0);
  } finally {
    for (const [object, key, value] of restore) object[key] = value;
    syncBuiltinESMExports();
    for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});
