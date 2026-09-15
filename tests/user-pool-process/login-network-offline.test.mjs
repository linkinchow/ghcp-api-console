import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { childEnv, enabled, gate, options, siblingUrl, validateMockOrigin } from './login-network-common.ts';
import { Process } from './login-network-harness.ts';

const valid = { MYSQL_POOL_LOGIN_NETWORK_TEST: '1', MYSQL_POOL_TEST_DISPOSABLE: '1',
  MYSQL_TEST_URL: 'mysql://root:synthetic@127.0.0.1:3306/ghcp_pool_test_optin' };

// Use the actual Process.stop/message methods but no constructor/fork/socket.
// send() deterministically delivers queued IPC and exit before the waiter's poll.
function stopFixture({ ack = true, code = 0, signal = null, fatal = false, exitedBeforeStop = false } = {}) {
  const process = Object.create(Process.prototype);
  const deliver = () => {
    if (ack) process.messages.push({ kind: 'stopped', pid: 123 });
    if (fatal) process.messages.push({ kind: 'fatal', pid: 123 });
    process.exited = true; process.code = code; process.signal = signal;
  };
  Object.assign(process, { messages: [], exited: false, code: null, signal: null,
    abort: new AbortController().signal, exit: Promise.resolve(),
    child: { send: message => { assert.deepEqual(message, { kind: 'stop' }); deliver(); } },
    kill: async () => { assert.fail('Already exited child must not be killed'); } });
  if (exitedBeforeStop) deliver();
  return process;
}

test('offline graceful stop accepts queued stopped plus zero exit, even before waiter observation', async () => {
  await stopFixture().stop();
  await stopFixture({ exitedBeforeStop: true }).stop();
});

test('offline graceful stop rejects missing ack, nonzero, signal and fatal; ordinary waits remain strict', async () => {
  for (const exitedBeforeStop of [false, true]) {
    await assert.rejects(stopFixture({ ack: false, exitedBeforeStop }).stop(), /without stopped acknowledgement/);
    await assert.rejects(stopFixture({ code: 2, exitedBeforeStop }).stop(), /must exit zero/);
    await assert.rejects(stopFixture({ signal: 'SIGKILL', exitedBeforeStop }).stop(), /must not be signal-terminated/);
    await assert.rejects(stopFixture({ fatal: true, exitedBeforeStop }).stop(), /failed during stop/);
  }
  const ordinary = stopFixture({ exitedBeforeStop: true });
  ordinary.messages.push({ kind: 'started', pid: 123 });
  await assert.rejects(ordinary.message('started'), /Unexpected child exit/);
});

test('offline graceful stop rechecks exit result after acknowledgement', async () => {
  const process = stopFixture();
  process.child.send = () => {
    process.messages.push({ kind: 'stopped', pid: 123 });
    // Deferred exit occurs only when stop() awaits it, after consuming the ACK.
    process.exit = { then: (resolve) => { process.exited = true; process.code = 2; resolve(); } };
  };
  await assert.rejects(process.stop(), /must exit zero/);
});

test('offline strict opt-ins, loopback random siblings and production timeout bound', () => {
  assert.equal(enabled({}), false); assert.throws(() => gate({}), /REFUSED/);
  assert.equal(enabled(valid), true);
  for (const key of Object.keys(valid)) {
    assert.throws(() => gate({ ...valid, [key]: undefined }));
    assert.throws(() => gate({ ...valid, [key]: '' }));
  }
  for (const url of ['mysql://root:x@192.0.2.1/ghcp_pool_test_x', 'mysql://user:x@127.0.0.1/ghcp_pool_test_x',
    'mysql://root:x@127.0.0.1/production', 'mysql://root:x@127.0.0.1/',
    'mysql://root:x@127.0.0.1/ghcp_pool_test_x?socketPath=x', 'mysql://root:x@127.0.0.1/ghcp_pool_test_x#x',
    'https://root:x@127.0.0.1/ghcp_pool_test_x', 'mysql://%72oot:x@127.0.0.1/ghcp_pool_test_x',
    'mysql://root:x@localhost.example/ghcp_pool_test_x', 'mysql://root:x@127.0.0.1/ghcp_pool_test_x%2fy']) {
    assert.throws(() => gate({ ...valid, MYSQL_TEST_URL: url }));
  }
  for (const url of ['http://localhost:4321', 'http://127.0.0.1:4321/path', 'https://127.0.0.1:4321',
    'http://127.0.0.1:4321?x=1', 'http://127.0.0.1']) assert.throws(() => validateMockOrigin(url));
  const marker = gate(valid); const first = siblingUrl(marker); const second = siblingUrl(marker);
  assert.match(first.database, /^ghcp_pool_test_[a-f0-9]{32}$/);
  assert.notEqual(first.database, second.database); assert.notEqual(first.url.pathname, marker.pathname);
  assert.equal(marker.pathname, '/ghcp_pool_test_optin'); assert.equal(first.admin.pathname, '/');
  assert.equal(options.requestTimeoutMs, 120000);
  assert.equal(options.prewarmConcurrency, 1); assert.equal(options.loginMaxPending, 1);
});

test('offline child environment cannot inherit dotenv, Node hooks, proxies or provider secrets', () => {
  const poison = { NODE_OPTIONS: '--require=forbidden', HTTP_PROXY: 'http://outside.invalid', HTTPS_PROXY: 'http://outside.invalid',
    ALL_PROXY: 'http://outside.invalid', http_proxy: 'http://outside.invalid', https_proxy: 'http://outside.invalid',
    all_proxy: 'http://outside.invalid', NODE_EXTRA_CA_CERTS: 'forbidden.pem', DOTENV_CONFIG_OVERRIDE: 'true',
    NODE_USE_ENV_PROXY: '1', POOL_REQUEST_TIMEOUT_SECONDS: '5',
    DOTENV_CONFIG_PATH: '.env', LOGIN_BASE_URL: 'https://outside.invalid', SSO_BASE_URL: 'https://outside.invalid',
    COPILOT_API_BASE_URL: 'https://outside.invalid', GITHUB_TOKEN: 'must-not-leak', MYSQL_URL: 'must-not-leak' };
  const saved = Object.fromEntries(Object.keys(poison).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, poison);
    const { url, database } = siblingUrl(gate(valid));
    const env = childEnv(url, database, 'http://127.0.0.1:32123', 'http://127.0.0.1:32124');
    for (const key of Object.keys(poison)) assert.notEqual(env[key], poison[key], key);
    assert.equal(env.POOL_REQUEST_TIMEOUT_SECONDS, undefined);
    assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.DOTENV_CONFIG_PATH, process.platform === 'win32' ? 'NUL' : '/dev/null');
    assert.equal(env.MYSQL_URL, url.toString());
    assert.equal(env.LOGIN_BASE_URL, 'http://127.0.0.1:32124');
    assert.equal(env.SSO_BASE_URL, 'http://127.0.0.1:32123');
  } finally { for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } }
});

test('offline entrypoints reject before sockets, listeners, fetch, child spawn or git', async () => {
  let attempts = 0; const restores = [];
  const deny = () => { attempts++; throw new Error('Offline side effect denied'); };
  for (const [object, keys] of [[net, ['connect', 'createConnection', 'createServer']], [net.Socket.prototype, ['connect']],
    [http, ['createServer', 'request', 'get']], [https, ['request', 'get']],
    [childProcess, ['spawn', 'spawnSync', 'fork', 'exec', 'execSync', 'execFile', 'execFileSync']], [globalThis, ['fetch']]]) {
    for (const key of keys) { restores.push([object, key, object[key]]); object[key] = deny; }
  }
  syncBuiltinESMExports();
  const argv = process.argv;
  const names = Object.keys(valid);
  const saved = Object.fromEntries(names.map(key => [key, process.env[key]]));
  try {
    process.argv = ['node', 'login-network-run.mjs', '--run'];
    for (const key of names) delete process.env[key];
    await assert.rejects(import('./login-network-run.mjs?offline=absent'), /REFUSED/);
    process.argv = ['node', 'child.ts'];
    for (const file of ['login-network-worker.ts', 'login-network-server.ts']) {
      await assert.rejects(import(`./${file}?offline=absent`), /REFUSED/);
    }
    for (const [tag, env] of [['partial', { MYSQL_POOL_LOGIN_NETWORK_TEST: '1' }],
      ['remote', { ...valid, MYSQL_TEST_URL: 'mysql://root:x@192.0.2.1/ghcp_pool_test_x' }]]) {
      for (const key of names) delete process.env[key]; Object.assign(process.env, env);
      for (const file of ['login-network-mysql.test.ts', 'login-network-worker.ts', 'login-network-server.ts']) {
        await assert.rejects(import(`./${file}?offline=${tag}`));
      }
      process.argv = ['node', 'login-network-run.mjs', '--run'];
      await assert.rejects(import(`./login-network-run.mjs?offline=${tag}`));
      process.argv = ['node', 'child.ts'];
    }
    assert.equal(attempts, 0, 'No attempted side effects before validation');
  } finally {
    for (const [object, key, value] of restores) object[key] = value;
    syncBuiltinESMExports(); process.argv = argv;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
